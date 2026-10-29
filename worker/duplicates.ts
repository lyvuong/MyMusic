/**
 * Finds songs the library holds more than once (same title and artist, about the same length) so the owner can keep one
 * copy and delete the rest. A copy that is in a playlist or has a rating is preferred, and what the removed copies had
 * (playlist places, ratings) is moved to the kept one first, so nothing points at a deleted song.
 */
import type { DupGroup, DupSong } from "../shared/types";
import { clearLibraryCache } from "./browse";
import { homeDeleteSongs } from "./home";
import { nasFetch, startScan } from "./nas";


const COMPILATION = /\b(greatest hits|best of|the best|very best|hits|collection|compilation|anthology|essential|now that|top \d+)\b/i;

const plain = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

/** The title without remaster / year / mono-stereo notes, which do not make another song; "(Live)" or "(Remix)" stay. */
export function titleKey(title: string): string {
  const t = plain(title)
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (m, a: string | undefined, b: string | undefined) => (/remaster|mono|stereo|deluxe|bonus|\b(19|20)\d\d\b/.test(a ?? b ?? "") ? " " : m))
    .replace(/\s-\s[^-]*remaster[^-]*$/, " ");
  return t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const artistKey = (artist: string) => plain(artist).replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^the /, "");

/** The copy to keep: one in playlists, then a rated one, then a played one, then from a real album rather than a compilation, then the biggest file. */
export function best(songs: DupSong[]): DupSong {
  const score = (s: DupSong) => [s.lists > 0 ? 1 : 0, s.rating > 0 ? 1 : 0, s.plays > 0 ? 1 : 0, COMPILATION.test(s.album) ? 0 : 1, s.size];
  return [...songs].sort((a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  })[0]!;
}

/** Groups songs with the same title and artist whose lengths lie within a few seconds of each other. */
export function groupDuplicates(songs: DupSong[]): DupGroup[] {
  const byName = new Map<string, DupSong[]>();
  for (const s of songs) {
    const t = titleKey(s.title);
    if (!t) continue;
    const k = `${t}\u0000${artistKey(s.artist)}`;
    const list = byName.get(k) ?? [];
    list.push(s);
    byName.set(k, list);
  }
  const groups: DupGroup[] = [];
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.duration - b.duration);
    let cluster: DupSong[] = [];
    const flush = () => {
      if (cluster.length > 1) groups.push({ songs: cluster, keep: best(cluster).id });
      cluster = [];
    };
    for (const s of sorted) {
      const last = cluster[cluster.length - 1];
      if (last && s.duration > 0 && last.duration > 0 && s.duration - last.duration > 6) flush();
      cluster.push(s);
    }
    flush();
  }
  return groups.sort((a, b) => a.songs[0]!.artist.localeCompare(b.songs[0]!.artist) || a.songs[0]!.title.localeCompare(b.songs[0]!.title));
}

export async function findDuplicates(db: D1Database, familyId: string): Promise<DupGroup[]> {
  const rows = (await db.prepare(
    "SELECT id, source, title, artist, album, duration, track_no AS trackNo, size FROM tracks WHERE family_id = ? AND deleted = 0",
  ).bind(familyId).all<Omit<DupSong, "lists" | "rating" | "plays">>()).results;
  const count = async (sql: string) => new Map((await db.prepare(sql).bind(familyId).all<{ id: string; n: number }>()).results.map((r) => [r.id, r.n]));
  const lists = await count(
    "SELECT pt.track_id AS id, COUNT(*) AS n FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id AND p.deleted = 0 WHERE p.family_id = ? GROUP BY pt.track_id",
  );
  const rated = await count("SELECT track_id AS id, MAX(rating) AS n FROM ratings WHERE family_id = ? GROUP BY track_id");
  const played = await count("SELECT track_id AS id, COUNT(*) AS n FROM plays WHERE family_id = ? GROUP BY track_id");
  return groupDuplicates(rows.map((r) => ({ ...r, lists: lists.get(r.id) ?? 0, rating: rated.get(r.id) ?? 0, plays: played.get(r.id) ?? 0 })));
}

/** Where Navidrome keeps a song, relative to the music folder: lets the home server pick the exact file among copies with the same names. */
async function pathOf(env: Env, sourceKey: string): Promise<string | undefined> {
  try {
    const res = await nasFetch(env, "getSong", { id: sourceKey });
    const j = (await res.json()) as { "subsonic-response"?: { song?: { path?: string } } };
    return j["subsonic-response"]?.song?.path || undefined;
  } catch {
    return undefined;
  }
}

export interface Resolution { removed: string[]; failed: { id: string; why: string }[] }

/**
 * Deletes the copies in each group but the kept one: the files on the home server (or the R2 object), then the library
 * rows, after moving their playlist places and ratings to the kept song. A copy the server could not delete is left alone.
 */
export async function resolveDuplicates(env: Env, familyId: string, groups: { keep: string; remove: string[] }[]): Promise<Resolution> {
  const ids = [...new Set(groups.flatMap((g) => [g.keep, ...g.remove]))];
  const rows = new Map<string, DupSong & { sourceKey: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const found = await env.DB.prepare(
      `SELECT id, source, source_key AS sourceKey, title, artist, album, duration, track_no AS trackNo, size, 0 AS lists, 0 AS rating, 0 AS plays FROM tracks WHERE family_id = ? AND deleted = 0 AND id IN (${part.map(() => "?").join(",")})`,
    ).bind(familyId, ...part).all<DupSong & { sourceKey: string }>();
    for (const r of found.results) rows.set(r.id, r);
  }
  const out: Resolution = { removed: [], failed: [] };
  const home: { keep: DupSong & { sourceKey: string }; remove: (DupSong & { sourceKey: string })[] }[] = [];
  const pairs: { keep: string; id: string }[] = [];
  for (const g of groups) {
    const keep = rows.get(g.keep);
    for (const id of g.remove) {
      const r = rows.get(id);
      if (!keep) out.failed.push({ id, why: "the song to keep was not found" });
      else if (!r) out.failed.push({ id, why: "not found" });
      else if (id === g.keep) out.failed.push({ id, why: "it is the song to keep" });
      else if (r.source === "r2") {
        const o = await env.DB.prepare("SELECT source_key, art_key FROM tracks WHERE id = ?").bind(id).first<{ source_key: string; art_key: string | null }>();
        if (o) await env.MUSIC.delete(o.art_key ? [o.source_key, o.art_key] : [o.source_key]);
        pairs.push({ keep: g.keep, id });
      } else {
        const h = home.find((x) => x.keep.id === g.keep);
        if (h) h.remove.push(r);
        else home.push({ keep, remove: [r] });
      }
    }
  }
  if (home.length) {
    const flat = home.flatMap((h) => h.remove.map((r) => ({ keep: h.keep.id, id: r.id })));
    try {
      const paths = new Map<string, string | undefined>();
      const need = [...new Set(home.flatMap((h) => [h.keep, ...h.remove]).map((s) => s.sourceKey))];
      for (let i = 0; i < need.length; i += 5) await Promise.all(need.slice(i, i + 5).map(async (k) => { paths.set(k, await pathOf(env, k)); }));
      const named = (s: DupSong & { sourceKey: string }) => ({ title: s.title, artist: s.artist, album: s.album, trackNo: s.trackNo, duration: s.duration, path: paths.get(s.sourceKey) });
      const { results } = await homeDeleteSongs(env, home.map((h) => ({ keep: named(h.keep), remove: h.remove.map(named) })));
      flat.forEach((f, i) => {
        const res = results[i];
        if (res?.status === "deleted") pairs.push(f);
        else out.failed.push({ id: f.id, why: res?.why || res?.status || "no answer from the server" });
      });
    } catch (e) {
      for (const f of flat) out.failed.push({ id: f.id, why: e instanceof Error ? e.message : "failed" });
    }
  }
  const now = Date.now();
  for (const p of pairs) {
    const inLists = (await env.DB.prepare("SELECT DISTINCT playlist_id AS id FROM playlist_tracks WHERE track_id = ?").bind(p.id).all<{ id: string }>()).results;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE playlist_tracks SET track_id = ? WHERE track_id = ? AND playlist_id NOT IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = ?)",
      ).bind(p.keep, p.id, p.keep),
      env.DB.prepare("DELETE FROM playlist_tracks WHERE track_id = ?").bind(p.id),
      env.DB.prepare("UPDATE OR IGNORE ratings SET track_id = ? WHERE track_id = ?").bind(p.keep, p.id),
      env.DB.prepare("DELETE FROM ratings WHERE track_id = ?").bind(p.id),
      env.DB.prepare("UPDATE tracks SET deleted = 1, art_key = NULL, updated_at = ? WHERE id = ? AND family_id = ?").bind(now, p.id, familyId),
      ...inLists.map((l) => env.DB.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").bind(now, l.id)),
    ]);
    out.removed.push(p.id);
  }
  if (out.removed.length) {
    await clearLibraryCache(env.DB, familyId);
    // So the next library sync does not bring the deleted songs back from Navidrome's old listing.
    await startScan(env).catch(() => undefined);
  }
  return out;
}
