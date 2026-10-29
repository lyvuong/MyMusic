/**
 * Songs added from a YouTube playlist are put in a MyMusic playlist of the same name. A song only exists in the library after
 * the next NAS sync, so the request waits in `pending_playlist` and is carried out by the sync (see finishSync).
 */

const KEEP_MS = 3 * 86400 * 1000;

/** A name compared loosely: no case, accents or punctuation, and no "(Remastered)"-style brackets. */
const loose = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\u0111/g, "d").replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export interface SongName { title: string; artist: string }

/** For each song, the id of the library song with the same title and artist (loosely compared), or null when it is not there. */
export async function findInLibrary(db: D1Database, familyId: string, songs: SongName[]): Promise<(string | null)[]> {
  const out: (string | null)[] = songs.map(() => null);
  // Candidates are found by an exact (case-blind) artist or title, then compared loosely, so "(Remastered)" or accents still match.
  const rows = new Map<string, { id: string; title: string; artist: string }>();
  for (const col of ["artist", "title"] as const) {
    const names = [...new Set(songs.map((s) => s[col].trim().toLowerCase()).filter(Boolean))];
    for (let i = 0; i < names.length; i += 50) {
      const part = names.slice(i, i + 50);
      const found = await db.prepare(
        `SELECT id, title, artist FROM tracks WHERE family_id = ? AND deleted = 0 AND lower(${col}) IN (${part.map(() => "?").join(",")})`,
      ).bind(familyId, ...part).all<{ id: string; title: string; artist: string }>();
      for (const r of found.results) rows.set(r.id, r);
    }
  }
  const byKey = new Map<string, string>();
  for (const r of rows.values()) {
    const k = `${loose(r.title)}\u0000${loose(r.artist)}`;
    if (!byKey.has(k)) byKey.set(k, r.id);
  }
  songs.forEach((s, i) => { out[i] = byKey.get(`${loose(s.title)}\u0000${loose(s.artist)}`) ?? null; });
  return out;
}

export async function queueForPlaylist(db: D1Database, familyId: string, uid: string, playlist: string, title: string, artist: string) {
  await db.prepare("INSERT INTO pending_playlist (family_id, owner_uid, playlist, title, artist, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(familyId, uid, playlist, title.normalize("NFC"), artist.normalize("NFC"), Date.now()).run();
}

/** Appends songs to the member's playlist of that name (created when missing), leaving out ones it already has. Returns how many were added. */
export async function addToPlaylist(db: D1Database, familyId: string, uid: string, name: string, trackIds: string[], now = Date.now()): Promise<number> {
  const old = await db.prepare("SELECT id FROM playlists WHERE family_id = ? AND owner_uid = ? AND name = ? AND deleted = 0 ORDER BY updated_at DESC LIMIT 1")
    .bind(familyId, uid, name).first<{ id: string }>();
  const id = old?.id ?? crypto.randomUUID();
  const have = old
    ? new Set((await db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?").bind(id).all<{ track_id: string }>()).results.map((r) => r.track_id))
    : new Set<string>();
  const next = old
    ? ((await db.prepare("SELECT MAX(pos) AS m FROM playlist_tracks WHERE playlist_id = ?").bind(id).first<{ m: number | null }>())?.m ?? -1) + 1
    : 0;
  const add = [...new Set(trackIds)].filter((t) => !have.has(t));
  await db.batch([
    db.prepare(
      "INSERT INTO playlists (id, family_id, owner_uid, name, shared, updated_at, deleted) VALUES (?, ?, ?, ?, 0, ?, 0) " +
        "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
    ).bind(id, familyId, uid, name, now),
    ...add.map((t, i) => db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, pos) VALUES (?, ?, ?)").bind(id, t, next + i)),
  ]);
  return add.length;
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
  for (const l of byList.values()) await addToPlaylist(db, familyId, l.uid, l.name, l.tids, now);
  for (const pid of done) await db.prepare("DELETE FROM pending_playlist WHERE id = ?").bind(pid).run();
  await db.prepare("DELETE FROM pending_playlist WHERE family_id = ? AND created_at < ?").bind(familyId, now - KEEP_MS).run();
}
