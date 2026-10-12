import { clearLibraryCache } from "./browse";
/**
 * Navidrome / Subsonic-API music server (reached through a Cloudflare Tunnel). Tracks synced from it have
 * source = 'nas', source_key = the Subsonic song id and art_key = 'nas:<coverArt id>'; audio and covers are
 * proxied through the Worker so the NAS credentials never reach a client.
 */

const PAGE = 500;

export const nasEnabled = (env: Env) => !!(env.NAS_BASE_URL && env.NAS_USER && env.NAS_PASSWORD);

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Calls a Subsonic REST endpoint with token auth (md5(password + salt)) and the optional Cloudflare Access service token. */
export async function nasFetch(env: Env, endpoint: string, params: Record<string, string | number> = {}, headers: HeadersInit = {}) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(8)).buffer);
  const token = hex(await crypto.subtle.digest("MD5", new TextEncoder().encode(env.NAS_PASSWORD + salt)));
  const url = new URL(`${env.NAS_BASE_URL!.replace(/\/+$/, "")}/rest/${endpoint}`);
  const all = { u: env.NAS_USER!, t: token, s: salt, v: "1.16.1", c: "MyMusic", f: "json", ...params };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, String(v));
  const h = new Headers(headers);
  if (env.NAS_CF_ACCESS_ID && env.NAS_CF_ACCESS_SECRET) {
    h.set("CF-Access-Client-Id", env.NAS_CF_ACCESS_ID);
    h.set("CF-Access-Client-Secret", env.NAS_CF_ACCESS_SECRET);
  }
  return fetch(url, { headers: h, signal: AbortSignal.timeout(20000) });
}

interface Song {
  id: string; title?: string; artist?: string; album?: string; duration?: number; track?: number;
  size?: number; contentType?: string; coverArt?: string; genre?: string;
}

/** D1 allows 100 bound parameters per query; leave room for the family id and a timestamp. */
const IN_CHUNK = 90;

/** A NAS song reduced to the values the library keeps. */
export interface NasSong {
  key: string; title: string; artist: string; album: string; duration: number; trackNo: number;
  artKey: string | null; size: number; mime: string; genre: string;
}

/** What D1 already holds for a NAS song. */
export interface StoredSong {
  title: string; artist: string; album: string; duration: number; track_no: number;
  art_key: string | null; size: number; mime: string; edited: number; deleted: number; genre: string;
}

const toNasSong = (s: Song): NasSong => ({
  key: s.id, title: s.title || "Unknown", artist: s.artist ?? "", album: s.album ?? "", duration: s.duration ?? 0, trackNo: s.track ?? 0,
  artKey: s.coverArt ? `nas:${s.coverArt}` : null, size: s.size ?? 0, mime: s.contentType ?? "audio/mpeg",
  genre: (s.genre ?? "").slice(0, 100),
});

/**
 * The songs that need a database write: new ones, ones that came back after being removed, and ones whose values
 * differ. Songs edited in the web app (edited = 1) keep their own names, so only the file values count for them.
 * Skipping the rest is what keeps a sync from rewriting the whole library (D1's free plan allows 100k row writes a day).
 */
export function changedSongs(stored: Map<string, StoredSong>, incoming: NasSong[]): NasSong[] {
  return incoming.filter((s) => {
    const o = stored.get(s.key);
    if (!o || o.deleted === 1) return true;
    if (o.duration !== s.duration || o.art_key !== s.artKey || o.size !== s.size || o.mime !== s.mime || o.genre !== s.genre) return true;
    return o.edited === 0 && (o.title !== s.title || o.artist !== s.artist || o.album !== s.album || o.track_no !== s.trackNo);
  });
}

/** The live NAS songs that are missing from the list the NAS just returned. */
export function goneSongIds(live: { id: string; source_key: string }[], seen: Iterable<string>): string[] {
  const keep = new Set(seen);
  return live.filter((t) => !keep.has(t.source_key)).map((t) => t.id);
}

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function storedFor(env: Env, familyId: string, keys: string[]): Promise<Map<string, StoredSong>> {
  const map = new Map<string, StoredSong>();
  for (const part of chunks(keys, IN_CHUNK)) {
    const rows = await env.DB.prepare(
      "SELECT source_key, title, artist, album, duration, track_no, art_key, size, mime, edited, deleted, genre FROM tracks " +
        `WHERE family_id = ? AND source = 'nas' AND source_key IN (${part.map(() => "?").join(",")})`,
    ).bind(familyId, ...part).all<StoredSong & { source_key: string }>();
    for (const r of rows.results) map.set(r.source_key, r);
  }
  return map;
}

/**
 * Imports one page of the NAS library into D1. The client repeats with `next` until `done`, then calls
 * finishSync with every id it saw. Only new and changed songs are written; `written` says how many that was.
 */
export async function syncPage(env: Env, familyId: string, offset: number) {
  const res = await nasFetch(env, "search3", { query: "", artistCount: 0, albumCount: 0, songCount: PAGE, songOffset: offset });
  if (!res.ok) throw new Error(`NAS answered ${res.status}`);
  const body = (await res.json()) as { "subsonic-response": { status: string; error?: { message: string }; searchResult3?: { song?: Song[] } } };
  const r = body["subsonic-response"];
  if (r.status !== "ok") throw new Error(r.error?.message ?? "NAS error");
  const songs = (r.searchResult3?.song ?? []).map(toNasSong);
  const todo = changedSongs(await storedFor(env, familyId, songs.map((s) => s.key)), songs);

  const now = Date.now();
  const upsert = env.DB.prepare(
    "INSERT INTO tracks (id, family_id, source, source_key, title, artist, album, duration, track_no, art_key, size, etag, mime, updated_at, sync_seen, genre) " +
      "VALUES (?, ?, 'nas', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(family_id, source, source_key) DO UPDATE SET " +
      // Songs edited in the web app (edited = 1) keep their title, artist, album and track number.
      "updated_at = CASE WHEN tracks.deleted = 1 " +
      "OR (tracks.edited = 0 AND (tracks.title IS NOT excluded.title OR tracks.artist IS NOT excluded.artist OR tracks.album IS NOT excluded.album OR tracks.track_no IS NOT excluded.track_no)) " +
      "OR tracks.duration IS NOT excluded.duration OR tracks.art_key IS NOT excluded.art_key OR tracks.size IS NOT excluded.size " +
      "OR tracks.genre IS NOT excluded.genre " +
      "THEN excluded.updated_at ELSE tracks.updated_at END, " +
      "title = CASE WHEN tracks.edited = 1 THEN tracks.title ELSE excluded.title END, " +
      "artist = CASE WHEN tracks.edited = 1 THEN tracks.artist ELSE excluded.artist END, " +
      "album = CASE WHEN tracks.edited = 1 THEN tracks.album ELSE excluded.album END, " +
      "duration = excluded.duration, " +
      "track_no = CASE WHEN tracks.edited = 1 THEN tracks.track_no ELSE excluded.track_no END, " +
      "art_key = excluded.art_key, size = excluded.size, etag = excluded.etag, mime = excluded.mime, genre = excluded.genre, deleted = 0, sync_seen = excluded.sync_seen",
  );
  const stmts = todo.map((s) =>
    upsert.bind(
      crypto.randomUUID(), familyId, s.key, s.title, s.artist, s.album, s.duration, s.trackNo,
      s.artKey, s.size, `${s.key}:${s.size}`, s.mime, now, now, s.genre,
    ),
  );
  for (const part of chunks(stmts, 100)) await env.DB.batch(part);

  return {
    imported: songs.length, written: todo.length, next: offset + songs.length, done: songs.length < PAGE,
    ids: songs.map((s) => s.key),
  };
}

/**
 * The last step of a sync, with the id of every song the NAS listed: marks the library's NAS songs that are no longer
 * there as removed, and applies the AI badge to songs added from YouTube as AI-generated. Writes only what changed.
 */
export async function finishSync(env: Env, familyId: string, seen: string[]) {
  const now = Date.now();
  const live = (await env.DB.prepare("SELECT id, source_key FROM tracks WHERE family_id = ? AND source = 'nas' AND deleted = 0")
    .bind(familyId).all<{ id: string; source_key: string }>()).results;
  const gone = goneSongIds(live, seen);
  // An empty or truncated listing (the NAS answered badly) must not wipe the library.
  const suspicious = live.length >= 10 && (seen.length === 0 || gone.length > live.length / 2);
  let removed = 0;
  if (!suspicious) {
    for (const part of chunks(gone, IN_CHUNK)) {
      await env.DB.prepare(
        `UPDATE tracks SET deleted = 1, art_key = NULL, updated_at = ? WHERE family_id = ? AND id IN (${part.map(() => "?").join(",")})`,
      ).bind(now, familyId, ...part).run();
      removed += part.length;
    }
  }
  // Songs added from YouTube as AI-generated get their badge now that they are in the library.
  const waiting = await env.DB.prepare("SELECT 1 AS x FROM pending_ai WHERE family_id = ? LIMIT 1").bind(familyId).first();
  if (waiting) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE tracks SET ai = 1, updated_at = ? WHERE family_id = ? AND deleted = 0 AND ai = 0 AND EXISTS " +
          "(SELECT 1 FROM pending_ai p WHERE p.family_id = tracks.family_id AND p.title = tracks.title AND p.artist = tracks.artist)",
      ).bind(now, familyId),
      env.DB.prepare(
        "DELETE FROM pending_ai WHERE family_id = ? AND (created_at < ? OR EXISTS " +
          "(SELECT 1 FROM tracks t WHERE t.family_id = pending_ai.family_id AND t.deleted = 0 AND t.ai = 1 AND t.title = pending_ai.title AND t.artist = pending_ai.artist))",
      ).bind(familyId, now - 3 * 86400 * 1000),
    ]);
  }
  await clearLibraryCache(env.DB, familyId);
  return { removed, skippedRemoval: suspicious ? gone.length : 0 };
}

/** Starts a Navidrome library scan (needs an admin NAS user). */
export async function startScan(env: Env): Promise<void> {
  const res = await nasFetch(env, "startScan");
  if (!res.ok) throw new Error(`NAS answered ${res.status}`);
  const r = ((await res.json()) as { "subsonic-response": { status: string; error?: { message: string } } })["subsonic-response"];
  if (r.status !== "ok") throw new Error(r.error?.message ?? "NAS error");
}

export async function scanning(env: Env): Promise<boolean> {
  const res = await nasFetch(env, "getScanStatus");
  if (!res.ok) throw new Error(`NAS answered ${res.status}`);
  const r = ((await res.json()) as { "subsonic-response": { status: string; scanStatus?: { scanning?: boolean } } })["subsonic-response"];
  return r.status === "ok" && !!r.scanStatus?.scanning;
}

/** Streams a NAS song (original file, Range honoured) to the client. */
export async function proxyStream(env: Env, songId: string, req: Request) {
  const range = req.headers.get("Range");
  const res = await nasFetch(env, "stream", { id: songId, format: "raw" }, range ? { Range: range } : {});
  if (!res.ok && res.status !== 206) return new Response("nas error", { status: 502 });
  const headers = new Headers();
  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("Accept-Ranges")) headers.set("Accept-Ranges", "bytes");
  return new Response(res.body, { status: res.status, headers });
}

/** Cover image for a NAS track; `coverId` is the part after "nas:" in art_key. */
export async function proxyCover(env: Env, coverId: string) {
  const res = await nasFetch(env, "getCoverArt", { id: coverId, size: 600 });
  const type = res.headers.get("Content-Type") ?? "";
  if (!res.ok || !type.startsWith("image/")) return new Response("not found", { status: 404 });
  return new Response(res.body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
}
