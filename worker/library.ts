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

/** Tracks and playlists changed after `since` (ms epoch); deleted rows come back as tombstones. */
export async function delta(db: D1Database, owner: string, since: number) {
  const tracks = await db.prepare("SELECT * FROM tracks WHERE updated_at > ? ORDER BY updated_at").bind(since).all<TrackRow>();
  const pls = await db
    .prepare("SELECT id, name, updated_at, deleted FROM playlists WHERE owner = ? AND updated_at > ?")
    .bind(owner, since).all<{ id: string; name: string; updated_at: number; deleted: number }>();
  const playlists: Playlist[] = [];
  for (const p of pls.results) {
    const items = await db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos").bind(p.id).all<{ track_id: string }>();
    playlists.push({ id: p.id, name: p.name, trackIds: items.results.map((i) => i.track_id), updatedAt: p.updated_at, deleted: !!p.deleted });
  }
  return { now: Date.now(), tracks: tracks.results.map(toTrack), playlists };
}

export async function savePlaylist(db: D1Database, owner: string, id: string, name: string, trackIds: string[]) {
  const now = Date.now();
  const existing = await db.prepare("SELECT owner FROM playlists WHERE id = ?").bind(id).first<{ owner: string }>();
  if (existing && existing.owner !== owner) return false;
  await db.batch([
    db.prepare(
      "INSERT INTO playlists (id, owner, name, updated_at, deleted) VALUES (?, ?, ?, ?, 0) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, deleted = 0",
    ).bind(id, owner, name, now),
    db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").bind(id),
    ...trackIds.map((t, i) => db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, pos) VALUES (?, ?, ?)").bind(id, t, i)),
  ]);
  return true;
}
