import { DAYPARTS, DAYPART_HINT, suggest, SuggestError, type Daypart } from "./suggest";

/**
 * Nightly AI mixes. A cron trigger builds, for every family member, one playlist per time of day (morning, afternoon,
 * evening, night) from their ratings and what the family plays most. The app downloads them on sync, so the car screen
 * never waits for the AI. Day-parts are relative; the app picks the one that matches the phone's local hour.
 */

export interface Mix {
  daypart: Daypart;
  title: string;
  intro: string;
  trackIds: string[];
  generatedAt: number;
}

const FRESH_MS = 20 * 3600 * 1000;
const MAX_MEMBERS_PER_RUN = 40; // keeps a run inside the Workers AI daily allowance; the rest go next night

export async function getMixes(db: D1Database, uid: string): Promise<Mix[]> {
  const r = await db.prepare("SELECT daypart, title, intro, track_ids, generated_at FROM daily_mixes WHERE uid = ?")
    .bind(uid).all<{ daypart: Daypart; title: string; intro: string; track_ids: string; generated_at: number }>();
  return r.results.map((m) => ({ daypart: m.daypart, title: m.title, intro: m.intro, trackIds: parseIds(m.track_ids), generatedAt: m.generated_at }));
}

function parseIds(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Builds the four mixes for one member. A failed day-part keeps yesterday's mix. Returns how many were saved. */
export async function buildMixesFor(env: Env, familyId: string, uid: string, force = false): Promise<number> {
  const existing = new Map((await getMixes(env.DB, uid)).map((m) => [m.daypart, m.generatedAt]));
  let saved = 0;
  for (const daypart of DAYPARTS) {
    if (!force && Date.now() - (existing.get(daypart) ?? 0) < FRESH_MS) continue;
    try {
      const s = await suggest(env, familyId, uid, DAYPART_HINT[daypart]);
      await env.DB.prepare(
        "INSERT INTO daily_mixes (uid, family_id, daypart, title, intro, track_ids, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(uid, daypart) DO UPDATE SET family_id = excluded.family_id, title = excluded.title, intro = excluded.intro, " +
          "track_ids = excluded.track_ids, generated_at = excluded.generated_at",
      ).bind(uid, familyId, daypart, s.title, s.intro, JSON.stringify(s.tracks.map((t) => t.id)), Date.now()).run();
      saved++;
    } catch (e) {
      if (e instanceof SuggestError && e.status === 400) return saved; // empty library or nothing to go on: skip the member
      console.warn(`mix ${daypart} for ${uid} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return saved;
}

/** The cron entry point: every member of every family, oldest mixes first. */
export async function buildAllMixes(env: Env, force = false): Promise<{ members: number; mixes: number }> {
  if (!env.AI) return { members: 0, mixes: 0 };
  const members = await env.DB.prepare(
    "SELECT m.uid, m.family_id, COALESCE(MIN(d.generated_at), 0) AS oldest FROM members m " +
      "LEFT JOIN daily_mixes d ON d.uid = m.uid GROUP BY m.uid ORDER BY oldest ASC LIMIT ?",
  ).bind(MAX_MEMBERS_PER_RUN).all<{ uid: string; family_id: string }>();
  let mixes = 0;
  for (const m of members.results) mixes += await buildMixesFor(env, m.family_id, m.uid, force);
  return { members: members.results.length, mixes };
}

