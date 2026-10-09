/** Per-user song ratings, 1-5 stars; 0 clears. */

export async function getRatings(db: D1Database, uid: string): Promise<Record<string, number>> {
  const rows = await db.prepare("SELECT track_id, rating FROM ratings WHERE uid = ?").bind(uid).all<{ track_id: string; rating: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.track_id, r.rating]));
}

/** Saves or clears one rating. Returns false when the song is not in the caller's family library. */
export async function setRating(db: D1Database, familyId: string, uid: string, trackId: string, rating: number): Promise<boolean> {
  if (rating === 0) {
    await db.prepare("DELETE FROM ratings WHERE uid = ? AND track_id = ?").bind(uid, trackId).run();
    return true;
  }
  const t = await db.prepare("SELECT 1 AS ok FROM tracks WHERE id = ? AND family_id = ? AND deleted = 0").bind(trackId, familyId).first();
  if (!t) return false;
  await db.prepare(
    "INSERT INTO ratings (uid, track_id, family_id, rating, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(uid, track_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at",
  ).bind(uid, trackId, familyId, rating, Date.now()).run();
  return true;
}
