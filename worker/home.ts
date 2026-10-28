import type { ServerStatus, YoutubeInfo, YoutubePlaylist } from "../shared/types";

/**
 * The API running on the home server (scripts/unraid/mymusic-api). The Worker reaches it through a Cloudflare Tunnel,
 * the same way it reaches Navidrome, authenticating with the Cloudflare Access service token and BEETS_AGENT_KEY.
 * There is no fallback: if it cannot be reached the caller gets an HomeError whose message is shown to the user.
 */

/** One edit to apply to the files. Songs are matched by their old names, which is all a Navidrome id tells us. */
export type TagOp =
  | { kind: "album" | "artist"; from: string; to: string }
  | { kind: "song"; match: { title: string; artist: string; album: string; trackNo: number }; set: { title?: string; artist?: string; album?: string; trackNo?: number } };

export class HomeError extends Error {
  /** The HTTP status the home server answered, when it answered. */
  status?: number;
}

export const homeConfigured = (env: Env) => !!(env.HOME_API_URL && env.BEETS_AGENT_KEY);

async function call<T>(env: Env, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<T> {
  if (!homeConfigured(env)) throw new HomeError("The home server API is not configured (set HOME_API_URL and the BEETS_AGENT_KEY secret).");
  const headers = new Headers({ "X-Agent-Key": env.BEETS_AGENT_KEY! });
  if (env.NAS_CF_ACCESS_ID && env.NAS_CF_ACCESS_SECRET) {
    headers.set("CF-Access-Client-Id", env.NAS_CF_ACCESS_ID);
    headers.set("CF-Access-Client-Secret", env.NAS_CF_ACCESS_SECRET);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${env.HOME_API_URL!.replace(/\/+$/, "")}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new HomeError(timedOut ? "The home server did not answer in time." : `Cannot reach the home server: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: { error?: string } & Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    /* not JSON (for example a Cloudflare error page) */
  }
  if (!res.ok) {
    const fail = (msg: string) => Object.assign(new HomeError(msg), { status: res.status });
    if (json.error) throw fail(String(json.error));
    if (res.status === 401 || res.status === 403) throw fail(`The home server refused the request (${res.status}). Check the Cloudflare Access policy and the shared key.`);
    if (res.status >= 520 || res.status === 502 || res.status === 504) throw fail(`The home server is not responding (${res.status}). Is the mymusic-api container running?`);
    throw fail(`The home server answered ${res.status}.`);
  }
  return json as T;
}

/** Quick reachability check, used to disable the features that need the server. */
export async function homeStatus(env: Env): Promise<ServerStatus> {
  if (!homeConfigured(env)) {
    return { configured: false, ok: false, error: "The home server API is not configured.", busy: null };
  }
  try {
    const r = await call<{ busy?: string | null; jobs?: { kind: string; id: string }[]; waiting?: number; autoImport?: boolean }>(env, "GET", "/health", undefined, 6000);
    return { configured: true, ok: true, error: "", busy: r.busy ?? null, jobs: r.jobs, waiting: r.waiting, autoImport: r.autoImport };
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : String(e), busy: null };
  }
}

export interface EditResult {
  written: number;
  skipped: string[];
  /** Songs listed in the Beets library whose file is gone from the disk (the library entry was still updated). */
  missing: string[];
  /** Cover updates: song files that got the image embedded (folders shared with other albums), and the folders where
   *  an existing folder image will still be shown first. */
  embedded?: number;
  shadowed?: string[];
  log: string;
}

/** Writes edited names into the files and the Beets library. Throws a HomeError when anything could not be written. */
export function homeEdit(env: Env, ops: TagOp[]): Promise<EditResult> {
  return call<EditResult>(env, "POST", "/edit", { ops }, 95000);
}

/** Writes a JPEG cover (base64) into the folders of an album. Throws a HomeError when it could not be written. */
export function homeCover(env: Env, album: string, image: string): Promise<EditResult> {
  return call<EditResult>(env, "POST", "/cover", { album, image }, 95000);
}

/** Identifies up to 5 songs by their sound (Chromaprint + AcoustID) on the home server. One entry per song, in order. */
export function homeFingerprint(env: Env, songs: { title: string; artist: string; album: string; trackNo: number }[]) {
  return call<{ results: { matches: { score: number; title: string; artist: string; albums: string[] }[]; why: string }[] }>(env, "POST", "/fingerprint", { songs }, 95000);
}

/** Starts a long job (an import, an enrich or a YouTube download); the server reports progress and the result to the Worker by run id. */
export async function homeStartJob(env: Env, id: string, kind: "import" | "enrich" | "youtube", extra: Record<string, string> = {}): Promise<void> {
  await call<{ id: string }>(env, "POST", "/jobs", { ...extra, id, kind }, 15000);
}

/** Lists the videos of a YouTube playlist without downloading them. */
export function homeYoutubePlaylist(env: Env, url: string): Promise<YoutubePlaylist> {
  return call<YoutubePlaylist>(env, "POST", "/yt-playlist", { url }, 130000);
}

/** Reads a YouTube video's title, artist and length without downloading it (a few seconds). */
export function homeYoutubeInfo(env: Env, url: string): Promise<YoutubeInfo> {
  return call<YoutubeInfo>(env, "POST", "/yt-info", { url }, 70000);
}
