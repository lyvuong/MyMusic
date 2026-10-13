/** Play history: feeds the family's "popular" list and the AI mixes. Skips only feed the skipping member's own mixes. */

const MAX_BATCH = 50;
const DAY_MS = 24 * 3600 * 1000;

type Event = { trackId: string; at: number };

/** The valid events of a batch (`at` = epoch ms, clamped to the last 30 days) whose songs are in the caller's family library. */
async function knownEvents(db: D1Database, familyId: string, events: Event[]): Promise<Event[]> {
  const now = Date.now();
  const clean = events
    .filter((p) => p && typeof p.trackId === "string" && Number.isFinite(p.at))
    .slice(0, MAX_BATCH)
    .map((p) => ({ trackId: p.trackId, at: Math.min(Math.max(Math.floor(p.at), now - 30 * DAY_MS), now) }));
  if (clean.length === 0) return [];
  const ids = [...new Set(clean.map((p) => p.trackId))];
  const known = await db.prepare(`SELECT id FROM tracks WHERE family_id = ? AND deleted = 0 AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(familyId, ...ids).all<{ id: string }>();
  const ok = new Set(known.results.map((r) => r.id));
  return clean.filter((p) => ok.has(p.trackId));
}

/** Stores plays (`at` = epoch ms). Songs outside the caller's family library are ignored. Returns how many were kept. */
export async function recordPlays(db: D1Database, familyId: string, uid: string, plays: Event[]): Promise<number> {
  const rows = await knownEvents(db, familyId, plays);
  if (rows.length === 0) return 0;
  await db.batch(rows.map((p) =>
    db.prepare("INSERT OR IGNORE INTO plays (uid, track_id, family_id, played_at) VALUES (?, ?, ?, ?)").bind(uid, p.trackId, familyId, p.at)));
  return rows.length;
}

/** Stores the songs the caller moved on from early (`at` = epoch ms). Returns how many were kept. */
export async function recordSkips(db: D1Database, familyId: string, uid: string, skips: Event[]): Promise<number> {
  const rows = await knownEvents(db, familyId, skips);
  if (rows.length === 0) return 0;
  await db.batch(rows.map((p) =>
    db.prepare("INSERT OR IGNORE INTO skips (uid, track_id, family_id, skipped_at) VALUES (?, ?, ?, ?)").bind(uid, p.trackId, familyId, p.at)));
  return rows.length;
}

/** The family's most played songs over the last [days], most played first. */
export async function popular(db: D1Database, familyId: string, days = 90, limit = 100): Promise<{ id: string; plays: number }[]> {
  const r = await db.prepare(
    "SELECT p.track_id AS id, COUNT(*) AS plays FROM plays p JOIN tracks t ON t.id = p.track_id AND t.deleted = 0 " +
      "WHERE p.family_id = ? AND p.played_at > ? GROUP BY p.track_id ORDER BY plays DESC, MAX(p.played_at) DESC LIMIT ?",
  ).bind(familyId, Date.now() - days * DAY_MS, limit).all<{ id: string; plays: number }>();
  return r.results;
}
