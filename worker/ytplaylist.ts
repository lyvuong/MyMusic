/**
 * Songs added from a YouTube playlist are put in a MyMusic playlist of the same name. A song only exists in the library after
 * the next NAS sync, so the request waits in `pending_playlist` and is carried out by the sync (see finishSync).
 */

const KEEP_MS = 3 * 86400 * 1000;

export async function queueForPlaylist(db: D1Database, familyId: string, uid: string, playlist: string, title: string, artist: string) {
  await db.prepare("INSERT INTO pending_playlist (family_id, owner_uid, playlist, title, artist, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(familyId, uid, playlist, title.normalize("NFC"), artist.normalize("NFC"), Date.now()).run();
}

/** Adds the waiting songs that are in the library now to their playlists (created when missing), in the order they were queued. */
export async function applyPendingPlaylists(db: D1Database, familyId: string, now = Date.now()) {
  const waiting = await db.prepare("SELECT 1 AS x FROM pending_playlist WHERE family_id = ? LIMIT 1").bind(familyId).first();
  if (!waiting) return;
  const found = (await db.prepare(
    "SELECT p.id AS pid, p.owner_uid AS uid, p.playlist AS name, t.id AS tid FROM pending_playlist p " +
      "JOIN tracks t ON t.family_id = p.family_id AND t.deleted = 0 AND t.title = p.title AND t.artist = p.artist " +
      "WHERE p.family_id = ? ORDER BY p.id",
  ).bind(familyId).all<{ pid: number; uid: string; name: string; tid: string }>()).results;
  const done = new Set<number>();
  const byList = new Map<string, { uid: string; name: string; tids: string[] }>();
  for (const f of found) {
    if (done.has(f.pid)) continue; // the same song twice in the library: the first one counts
    done.add(f.pid);
    const key = `${f.uid}\u0000${f.name}`;
    const l = byList.get(key) ?? { uid: f.uid, name: f.name, tids: [] };
    l.tids.push(f.tid);
    byList.set(key, l);
  }
  for (const l of byList.values()) {
    const old = await db.prepare("SELECT id FROM playlists WHERE family_id = ? AND owner_uid = ? AND name = ? AND deleted = 0 ORDER BY updated_at DESC LIMIT 1")
      .bind(familyId, l.uid, l.name).first<{ id: string }>();
    const id = old?.id ?? crypto.randomUUID();
    const have = old
      ? new Set((await db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?").bind(id).all<{ track_id: string }>()).results.map((r) => r.track_id))
      : new Set<string>();
    const next = old
      ? ((await db.prepare("SELECT MAX(pos) AS m FROM playlist_tracks WHERE playlist_id = ?").bind(id).first<{ m: number | null }>())?.m ?? -1) + 1
      : 0;
    const add = [...new Set(l.tids)].filter((t) => !have.has(t));
    await db.batch([
      db.prepare(
        "INSERT INTO playlists (id, family_id, owner_uid, name, shared, updated_at, deleted) VALUES (?, ?, ?, ?, 0, ?, 0) " +
          "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
      ).bind(id, familyId, l.uid, l.name, now),
      ...add.map((t, i) => db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, pos) VALUES (?, ?, ?)").bind(id, t, next + i)),
    ]);
  }
  for (const pid of done) await db.prepare("DELETE FROM pending_playlist WHERE id = ?").bind(pid).run();
  await db.prepare("DELETE FROM pending_playlist WHERE family_id = ? AND created_at < ?").bind(familyId, now - KEEP_MS).run();
}
