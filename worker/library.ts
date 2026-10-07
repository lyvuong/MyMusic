import type { Playlist, Track } from "../shared/types";

interface TrackRow {
  id: string; source: "r2" | "nas"; title: string; artist: string; album: string; duration: number;
  track_no: number; art_key: string | null; size: number; etag: string; mime: string; updated_at: number; deleted: number;
}

export const toTrack = (r: TrackRow): Track => ({
  id: r.id, source: r.source, title: r.title, artist: r.artist, album: r.album, duration: r.duration,
  trackNo: r.track_no, hasArt: !!r.art_key, size: r.size, etag: r.etag, mime: r.mime,
  updatedAt: r.updated_at, deleted: !!r.deleted,
});

/**
 * Tracks and playlists in the family changed after `since` (ms epoch); deleted rows come back as
 * tombstones. Playlists are the caller's own plus ones other members marked shared.
 */
export async function delta(db: D1Database, familyId: string, uid: string, since: number) {
  const tracks = await db.prepare("SELECT * FROM tracks WHERE family_id = ? AND updated_at > ? ORDER BY updated_at")
    .bind(familyId, since).all<TrackRow>();
  const pls = await db
    .prepare("SELECT id, name, owner_uid, shared, updated_at, deleted FROM playlists WHERE family_id = ? AND updated_at > ? AND (owner_uid = ? OR shared = 1)")
    .bind(familyId, since, uid)
    .all<{ id: string; name: string; owner_uid: string; shared: number; updated_at: number; deleted: number }>();
  const playlists: Playlist[] = [];
  for (const p of pls.results) {
    const items = await db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos").bind(p.id).all<{ track_id: string }>();
    playlists.push({
      id: p.id, name: p.name, ownerUid: p.owner_uid, shared: !!p.shared,
      trackIds: items.results.map((i) => i.track_id), updatedAt: p.updated_at, deleted: !!p.deleted,
    });
  }
  return { now: Date.now(), tracks: tracks.results.map(toTrack), playlists };
}

/** Creates or updates one of the caller's playlists. Returns false if the id belongs to someone else. */
export async function savePlaylist(
  db: D1Database, familyId: string, uid: string, id: string, name: string, shared: boolean, trackIds: string[],
) {
  const now = Date.now();
  const existing = await db.prepare("SELECT owner_uid, family_id FROM playlists WHERE id = ?").bind(id)
    .first<{ owner_uid: string; family_id: string }>();
  if (existing && (existing.owner_uid !== uid || existing.family_id !== familyId)) return false;
  // Only keep tracks that belong to this family.
  const ids = trackIds.length
    ? new Set((await db.prepare(`SELECT id FROM tracks WHERE family_id = ? AND id IN (${trackIds.map(() => "?").join(",")})`)
        .bind(familyId, ...trackIds).all<{ id: string }>()).results.map((r) => r.id))
    : new Set<string>();
  const valid = trackIds.filter((t) => ids.has(t));
  await db.batch([
    db.prepare(
      "INSERT INTO playlists (id, family_id, owner_uid, name, shared, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, shared = excluded.shared, updated_at = excluded.updated_at, deleted = 0",
    ).bind(id, familyId, uid, name, shared ? 1 : 0, now),
    db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").bind(id),
    ...valid.map((t, i) => db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, pos) VALUES (?, ?, ?)").bind(id, t, i)),
  ]);
  return true;
}
