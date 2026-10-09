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
  size?: number; contentType?: string; coverArt?: string;
}

/**
 * Imports one page of the NAS library into D1. `run` identifies the sync; the client repeats with `next`
 * until `done`, and the last call removes tracks that disappeared from the NAS.
 */
export async function syncPage(env: Env, familyId: string, offset: number, run: number) {
  const res = await nasFetch(env, "search3", { query: "", artistCount: 0, albumCount: 0, songCount: PAGE, songOffset: offset });
  if (!res.ok) throw new Error(`NAS answered ${res.status}`);
  const body = (await res.json()) as { "subsonic-response": { status: string; error?: { message: string }; searchResult3?: { song?: Song[] } } };
  const r = body["subsonic-response"];
  if (r.status !== "ok") throw new Error(r.error?.message ?? "NAS error");
  const songs = r.searchResult3?.song ?? [];

  const now = Date.now();
  const upsert = env.DB.prepare(
    "INSERT INTO tracks (id, family_id, source, source_key, title, artist, album, duration, track_no, art_key, size, etag, mime, updated_at, sync_seen) " +
      "VALUES (?, ?, 'nas', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(family_id, source, source_key) DO UPDATE SET " +
      // Songs edited in the web app (edited = 1) keep their title, artist, album and track number.
      "updated_at = CASE WHEN tracks.deleted = 1 " +
      "OR (tracks.edited = 0 AND (tracks.title IS NOT excluded.title OR tracks.artist IS NOT excluded.artist OR tracks.album IS NOT excluded.album OR tracks.track_no IS NOT excluded.track_no)) " +
      "OR tracks.duration IS NOT excluded.duration OR tracks.art_key IS NOT excluded.art_key OR tracks.size IS NOT excluded.size " +
      "THEN excluded.updated_at ELSE tracks.updated_at END, " +
      "title = CASE WHEN tracks.edited = 1 THEN tracks.title ELSE excluded.title END, " +
      "artist = CASE WHEN tracks.edited = 1 THEN tracks.artist ELSE excluded.artist END, " +
      "album = CASE WHEN tracks.edited = 1 THEN tracks.album ELSE excluded.album END, " +
      "duration = excluded.duration, " +
      "track_no = CASE WHEN tracks.edited = 1 THEN tracks.track_no ELSE excluded.track_no END, " +
      "art_key = excluded.art_key, size = excluded.size, etag = excluded.etag, mime = excluded.mime, deleted = 0, sync_seen = excluded.sync_seen",
  );
  const stmts = songs.map((s) =>
    upsert.bind(
      crypto.randomUUID(), familyId, s.id, s.title || "Unknown", s.artist ?? "", s.album ?? "", s.duration ?? 0, s.track ?? 0,
      s.coverArt ? `nas:${s.coverArt}` : null, s.size ?? 0, `${s.id}:${s.size ?? 0}`, s.contentType ?? "audio/mpeg", now, run,
    ),
  );
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  const done = songs.length < PAGE;
  let removed = 0;
  if (done) {
    const gone = await env.DB.prepare(
      "UPDATE tracks SET deleted = 1, art_key = NULL, updated_at = ? WHERE family_id = ? AND source = 'nas' AND deleted = 0 AND (sync_seen IS NULL OR sync_seen != ?)",
    ).bind(now, familyId, run).run();
    removed = gone.meta.changes ?? 0;
  }
  return { imported: songs.length, next: offset + songs.length, done, removed };
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
