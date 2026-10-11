import type { Playlist, Track } from "../shared/types";

interface TrackRow {
  id: string; source: "r2" | "nas"; title: string; artist: string; album: string; duration: number;
  track_no: number; art_key: string | null; size: number; etag: string; mime: string; updated_at: number; deleted: number; ai: number;
}

export const toTrack = (r: TrackRow): Track => ({
  id: r.id, source: r.source, title: r.title, artist: r.artist, album: r.album, duration: r.duration,
  trackNo: r.track_no, hasArt: !!r.art_key, size: r.size, etag: r.etag, mime: r.mime,
  updatedAt: r.updated_at, deleted: !!r.deleted, ai: !!r.ai,
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

/** Text typed by a person: Unicode NFC (so Vietnamese diacritics compare equal whatever produced them), trimmed. */
export const cleanName = (s: unknown, max = 200) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, max);

export interface TrackEdit { title?: string; artist?: string; album?: string; trackNo?: number; ai?: boolean }

/**
 * An artist or album name may already exist spelled with decomposed diacritics (common in file tags). Returns that
 * stored spelling when it is the same text as `name`, so a rename or merge lands on the existing entry, else `name`.
 */
async function canonicalName(db: D1Database, familyId: string, col: "artist" | "album", name: string): Promise<string> {
  const rows = await db.prepare(`SELECT DISTINCT ${col} AS n FROM tracks WHERE family_id = ? AND deleted = 0 AND ${col} != ''`)
    .bind(familyId).all<{ n: string }>();
  const names = rows.results.map((r) => r.n);
  return names.includes(name) ? name : (names.find((n) => n.normalize("NFC") === name) ?? name);
}

/** What an edit changed, so the caller can queue the same change for the files on the home server. */
export interface TrackEditResult {
  /** Only NAS songs have files that Beets manages. */
  source: "r2" | "nas";
  before: { title: string; artist: string; album: string; trackNo: number };
  applied: { title?: string; artist?: string; album?: string; trackNo?: number };
}

/**
 * Edits one song's names. The song is flagged so the NAS sync does not put the file's tags back.
 * Returns null when the song is not in this family's library.
 */
export async function editTrack(
  db: D1Database, familyId: string, id: string, e: TrackEdit, beforeCommit?: (plan: TrackEditResult) => Promise<void>,
): Promise<TrackEditResult | null> {
  const row = await db.prepare("SELECT source, title, artist, album, track_no, ai FROM tracks WHERE id = ? AND family_id = ? AND deleted = 0")
    .bind(id, familyId).first<{ source: "r2" | "nas"; title: string; artist: string; album: string; track_no: number; ai: number }>();
  if (!row) return null;
  const before = { title: row.title, artist: row.artist, album: row.album, trackNo: row.track_no };
  const applied: TrackEditResult["applied"] = {};
  if (e.title !== undefined) applied.title = e.title;
  if (e.artist !== undefined) applied.artist = e.artist && await canonicalName(db, familyId, "artist", e.artist);
  if (e.album !== undefined) applied.album = e.album && await canonicalName(db, familyId, "album", e.album);
  if (e.trackNo !== undefined) applied.trackNo = e.trackNo;
  // Only what really changed goes to the files.
  for (const k of Object.keys(applied) as (keyof typeof applied)[]) if (applied[k] === before[k]) delete applied[k];
  if (Object.keys(applied).length === 0) {
    // Only the AI badge changed: no file is touched, and the song is not flagged as edited (names still follow the NAS).
    if (e.ai !== undefined && e.ai !== !!row.ai) {
      await db.prepare("UPDATE tracks SET ai = ?, updated_at = ? WHERE id = ? AND family_id = ?").bind(e.ai ? 1 : 0, Date.now(), id, familyId).run();
    }
    return { source: row.source, before, applied };
  }
  // Lets the caller write the files first; if it throws, nothing is changed here.
  await beforeCommit?.({ source: row.source, before, applied });
  await db.prepare("UPDATE tracks SET title = ?, artist = ?, album = ?, track_no = ?, ai = ?, edited = 1, updated_at = ? WHERE id = ? AND family_id = ?")
    .bind(applied.title ?? before.title, applied.artist ?? before.artist, applied.album ?? before.album, applied.trackNo ?? before.trackNo,
      e.ai === undefined ? row.ai : e.ai ? 1 : 0, Date.now(), id, familyId).run();
  return { source: row.source, before, applied };
}

/**
 * Changes the titles of up to 90 songs at once (the Vietnamese clean-up). Like editTrack, `beforeCommit` gets every plan
 * first so the files can be written in one go; if it throws nothing is changed here. Unknown songs and unchanged
 * titles are skipped. The songs are flagged as edited so the NAS sync keeps the new titles.
 */
export async function editTitles(
  db: D1Database, familyId: string, edits: { id: string; title: string }[],
  beforeCommit?: (plans: TrackEditResult[]) => Promise<void>,
): Promise<{ updated: number; skipped: number }> {
  if (edits.length === 0) return { updated: 0, skipped: 0 };
  const rows = await db.prepare(
    `SELECT id, source, title, artist, album, track_no FROM tracks WHERE family_id = ? AND deleted = 0 AND id IN (${edits.map(() => "?").join(",")})`,
  ).bind(familyId, ...edits.map((e) => e.id)).all<{ id: string; source: "r2" | "nas"; title: string; artist: string; album: string; track_no: number }>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const todo: { id: string; plan: TrackEditResult }[] = [];
  for (const e of edits) {
    const row = byId.get(e.id);
    if (!row || row.title === e.title) continue;
    todo.push({
      id: e.id,
      plan: { source: row.source, before: { title: row.title, artist: row.artist, album: row.album, trackNo: row.track_no }, applied: { title: e.title } },
    });
  }
  if (todo.length === 0) return { updated: 0, skipped: edits.length };
  await beforeCommit?.(todo.map((t) => t.plan));
  const now = Date.now();
  await db.batch(todo.map((t) =>
    db.prepare("UPDATE tracks SET title = ?, edited = 1, updated_at = ? WHERE id = ? AND family_id = ?").bind(t.plan.applied.title, now, t.id, familyId)));
  return { updated: todo.length, skipped: edits.length - todo.length };
}

/**
 * Renames an artist or an album on all of its songs. When `to` is a name that already exists the two become one,
 * which is how albums (and artists) are merged; an album with no songs left simply disappears.
 * `from` must be the stored name exactly. Returns how many songs changed, the final name, and how many of those
 * songs are NAS files (the ones whose tags can be rewritten).
 */
export async function renameGroup(
  db: D1Database, familyId: string, kind: "artist" | "album", from: string, to: string,
  beforeCommit?: (plan: { target: string; nas: number }) => Promise<void>,
): Promise<{ updated: number; target: string; nas: number }> {
  const col = kind === "artist" ? "artist" : "album";
  const target = await canonicalName(db, familyId, col, to);
  if (target === from) return { updated: 0, target, nas: 0 };
  const nas = await db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE family_id = ? AND deleted = 0 AND source = 'nas' AND ${col} = ?`)
    .bind(familyId, from).first<{ n: number }>();
  await beforeCommit?.({ target, nas: nas?.n ?? 0 });
  const r = await db.prepare(`UPDATE tracks SET ${col} = ?, edited = 1, updated_at = ? WHERE family_id = ? AND deleted = 0 AND ${col} = ?`)
    .bind(target, Date.now(), familyId, from).run();
  return { updated: r.meta.changes ?? 0, target, nas: nas?.n ?? 0 };
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
