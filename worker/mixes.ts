import { judgeSongs } from "./fame";
import { saveTaste, tasteProfile } from "./taste";
import { DAYPARTS, DAYPART_HINT, loadRows, suggest, SuggestError, type Daypart } from "./suggest";

/**
 * Nightly AI mixes. The home server calls /api/beets/agent/mixes once a night (the free Workers plan has no spare cron
 * triggers); it builds, for every family member, one playlist per time of day (morning, afternoon, evening, night) from
 * their ratings and what the family plays most. The app downloads them on sync, so the car screen never waits for the
 * AI. Day-parts are relative; the app picks the one that matches the phone's local hour.
 */

export interface Mix {
  daypart: Daypart;
  title: string;
  intro: string;
  trackIds: string[];
  generatedAt: number;
}

const FRESH_MS = 20 * 3600 * 1000;
const MAX_MEMBERS_PER_CALL = 5; // 4 AI calls each: keeps one request short

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
export async function buildMixesFor(env: Env, familyId: string, uid: string, force = false, lastSeen = Infinity): Promise<number> {
  const existing = new Map((await getMixes(env.DB, uid)).map((m) => [m.daypart, m.generatedAt]));
  let saved = 0;
  let rows: Awaited<ReturnType<typeof loadRows>> | undefined; // one read of the library for all four day-parts
  for (const daypart of DAYPARTS) {
    const built = existing.get(daypart) ?? 0;
    if (!force && Date.now() - built < FRESH_MS) continue;
    // Nobody opened the app since this mix was made, so it is still the one they would see: keep it.
    if (!force && built > 0 && lastSeen <= built) continue;
    try {
      if (!rows) {
        rows = await loadRows(env, familyId, uid);
        await saveTaste(env.DB, familyId, uid, tasteProfile(rows));
      }
      const s = await suggest(env, familyId, uid, DAYPART_HINT[daypart], rows);
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

/**
 * One slice of the nightly run: members `offset` .. `offset + limit` in a stable order. The home server calls this
 * repeatedly (offset 0, limit, 2 * limit, ...) until `members` comes back smaller than `limit`; each call stays
 * short enough for one request. Day-parts built less than 20 hours ago are left alone.
 */
export async function buildMixSlice(env: Env, offset: number, limit: number): Promise<{ members: number; mixes: number }> {
  if (!env.AI) return { members: 0, mixes: 0 };
  const take = Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_MEMBERS_PER_CALL);
  const members = await env.DB.prepare("SELECT uid, family_id, last_seen_at FROM members ORDER BY uid LIMIT ? OFFSET ?")
    .bind(take, Math.max(Math.floor(offset) || 0, 0)).all<{ uid: string; family_id: string; last_seen_at: number }>();
  let mixes = 0;
  // Songs the AI has not rated for popularity yet (a couple of batches per family per run), before the mixes use them.
  for (const familyId of new Set(members.results.map((m) => m.family_id))) await judgeFamily(env, familyId);
  for (const m of members.results) mixes += await buildMixesFor(env, m.family_id, m.uid, false, m.last_seen_at);
  return { members: members.results.length, mixes };
}

/** Judges song popularity for a family unless everything was judged and the library has not changed since. */
async function judgeFamily(env: Env, familyId: string): Promise<void> {
  const done = await env.DB.prepare("SELECT 1 AS x FROM family_cache WHERE family_id = ? AND key = 'fame_done'").bind(familyId).first();
  if (done) return;
  const r = await judgeSongs(env, familyId);
  if (r.judged > 0) await env.DB.prepare("DELETE FROM family_cache WHERE family_id = ? AND key = 'popular'").bind(familyId).run();
  if (r.done) {
    await env.DB.prepare("INSERT OR REPLACE INTO family_cache (family_id, key, json, built_at) VALUES (?, 'fame_done', 'true', ?)")
      .bind(familyId, Date.now()).run();
  }
}
