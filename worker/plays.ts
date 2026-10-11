/** Play history: feeds the family's "popular" list and the AI mixes. */

const MAX_BATCH = 50;
const DAY_MS = 24 * 3600 * 1000;

/** Stores plays (`at` = epoch ms). Songs outside the caller's family library are ignored. Returns how many were kept. */
export async function recordPlays(db: D1Database, familyId: string, uid: string, plays: { trackId: string; at: number }[]): Promise<number> {
  const now = Date.now();
  const clean = plays
    .filter((p) => p && typeof p.trackId === "string" && Number.isFinite(p.at))
    .slice(0, MAX_BATCH)
    .map((p) => ({ trackId: p.trackId, at: Math.min(Math.max(Math.floor(p.at), now - 30 * DAY_MS), now) }));
  if (clean.length === 0) return 0;
  const ids = [...new Set(clean.map((p) => p.trackId))];
  const known = await db.prepare(`SELECT id FROM tracks WHERE family_id = ? AND deleted = 0 AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(familyId, ...ids).all<{ id: string }>();
  const ok = new Set(known.results.map((r) => r.id));
  const rows = clean.filter((p) => ok.has(p.trackId));
  if (rows.length === 0) return 0;
  await db.batch(rows.map((p) =>
    db.prepare("INSERT OR IGNORE INTO plays (uid, track_id, family_id, played_at) VALUES (?, ?, ?, ?)").bind(uid, p.trackId, familyId, p.at)));
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
