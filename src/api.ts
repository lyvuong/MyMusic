import type { BeetsRun, FamilyInfo, Playlist, ServerStatus, Suggestion, Track, YoutubeInfo } from "../shared/types";
import { auth } from "./firebase";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function token(): Promise<string> {
  const t = await auth.currentUser?.getIdToken();
  if (!t) throw new ApiError(401, "Not signed in");
  return t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json().catch(() => null)) as T;
}

export interface LibraryDelta {
  now: number;
  tracks: Track[];
  playlists: Playlist[];
}

export const api = {
  family: async (): Promise<FamilyInfo | null> => {
    try {
      return await call<FamilyInfo>("GET", "/api/family");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  createFamily: (name: string) => call<FamilyInfo>("POST", "/api/family", { name }),
  joinFamily: (code: string) => call<FamilyInfo>("POST", "/api/family/join", { code }),
  invite: () => call<{ code: string; expiresAt: number }>("POST", "/api/family/invites"),
  removeMember: (uid: string) => call<void>("DELETE", `/api/family/members/${uid}`),
  deleteAccount: () => call<void>("DELETE", "/api/account"),
  library: (since: number) => call<LibraryDelta>("GET", `/api/library?since=${since}`),
  savePlaylist: (p: { id: string; name: string; shared: boolean; trackIds: string[] }) =>
    call<void>("PUT", `/api/playlists/${p.id}`, { name: p.name, shared: p.shared, trackIds: p.trackIds }),
  deletePlaylist: (id: string) => call<void>("DELETE", `/api/playlists/${id}`),
  syncNas: (offset: number, run: number) =>
    call<{ imported: number; next: number; done: boolean; removed: number }>("POST", "/api/nas/sync", { offset, run }),
  scanNas: () => call<{ ok: boolean }>("POST", "/api/nas/scan"),
  nasScanning: () => call<{ scanning: boolean }>("GET", "/api/nas/scan"),
  serverStatus: () => call<ServerStatus>("GET", "/api/server/status"),
  beetsRuns: () => call<{ runs: BeetsRun[] }>("GET", "/api/beets/runs"),
  runBeets: () => call<BeetsRun>("POST", "/api/beets/run"),
  runEnrich: () => call<BeetsRun>("POST", "/api/beets/enrich"),
  youtubeInfo: (url: string) => call<YoutubeInfo>("POST", "/api/beets/youtube/info", { url }),
  importYoutube: (v: { url: string; title: string; artist: string; album: string; ai: boolean }) => call<BeetsRun>("POST", "/api/beets/youtube", v),
  ratings: () => call<{ ratings: Record<string, number> }>("GET", "/api/ratings"),
  rateTrack: (id: string, rating: number) => call<void>("PUT", `/api/ratings/${id}`, { rating }),
  suggest: (prompt: string) => call<Suggestion>("POST", "/api/suggest", { prompt }),
  fetchArt: () => call<{ updated: number; remaining: number }>("POST", "/api/art/fetch"),
  editTrack: (id: string, e: { title?: string; artist?: string; album?: string; trackNo?: number; ai?: boolean }) => call<{ ok: boolean; filesUpdated: boolean; warning: string }>("PATCH", `/api/tracks/${id}`, e),
  /** Renames an artist or album on all its songs; an existing name merges the two. */
  renameGroup: (kind: "artist" | "album", from: string, to: string) => call<{ updated: number; filesUpdated: boolean; warning: string }>("POST", "/api/library/rename", { kind, from, to }),
  setAlbumCover: (album: string, image: string) => call<{ ok: boolean; filesUpdated: boolean; warning: string }>("POST", "/api/library/cover", { album, image }),
  castMedia: (ids: string[]) => call<{ items: Record<string, { stream: string; art: string | null }> }>("POST", "/api/cast/media", { ids }),
  deleteTrack: (id: string) => call<void>("DELETE", `/api/tracks/${id}`),

  /** URL for <audio>/<img>, which cannot send an Authorization header. */
  async mediaUrl(kind: "stream" | "art" | "artist-art", id: string, version?: number): Promise<string> {
    // `v` only changes the URL, so a replaced cover is not served from the browser cache.
    return `/api/${kind}/${id}?access_token=${encodeURIComponent(await token())}${version ? `&v=${version}` : ""}`;
  },
};
