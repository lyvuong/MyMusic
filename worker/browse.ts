import type { BrowsePage, HomeData, MixInfo, Track } from "../shared/types";
import { toTrack, type TrackRow } from "./library";
import { getMixes } from "./mixes";
import { popular } from "./plays";

/**
 * Finding songs without reading the library. Search uses the full-text index (migration 0018), "recently added" walks the
 * songs newest first and stops after a page, and the lists that need a scan (genres, most played) are kept for a few
 * hours in family_cache. A request reads a few hundred rows however large the library is.
 */

const IN_CHUNK = 90; // D1 allows 100 bound parameters per query
const HOUR = 3600 * 1000;
const POPULAR_TTL = 6 * HOUR;
const GENRES_TTL = 6 * HOUR;
const USER_LISTS_TTL = 3 * HOUR;
const REDISCOVER_AFTER_DAYS = 60;
export const PAGE_SONGS = 60;
/** Albums and artists are built from a window of songs, so a page of them reads more songs than a page of songs. */
export const PAGE_GROUPED = 300;
const MAX_OFFSET = 2000;

/** What the full-text index holds for a name: lowercase letters and digits, accents removed, d with stroke as d. */
export function foldWords(s: string): string[] {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean).slice(0, 6).map((w) => w.slice(0, 40));
}

/** An FTS5 query where every typed word is a prefix: `"con"* "yeu"*`. Null when nothing searchable was typed. */
export function matchQuery(q: string, column?: "artist" | "album"): string | null {
  const words = foldWords(q);
  if (words.length === 0) return null;
  const terms = words.map((w) => `"${w}"*`).join(" ");
  return column ? `${column} : (${terms})` : terms;
}

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** The songs with these ids (of this family, not deleted), in the order of `ids`. */
export async function tracksByIds(db: D1Database, familyId: string, ids: string[]): Promise<Track[]> {
  const unique = [...new Set(ids)];
  const found = new Map<string, Track>();
  for (const part of chunks(unique, IN_CHUNK)) {
    const r = await db.prepare(`SELECT * FROM tracks WHERE family_id = ? AND deleted = 0 AND id IN (${part.map(() => "?").join(",")})`)
      .bind(familyId, ...part).all<TrackRow>();
    for (const row of r.results) found.set(row.id, toTrack(row));
  }
  return ids.map((id) => found.get(id)).filter((t): t is Track => !!t);
}

/**
 * One page of songs. With text: best matches first (`cursor` is an offset). Without: newest first (`cursor` is the rowid of
 * the last song seen). `genre` narrows either. `limit` is how many songs a page holds.
 */
export async function browse(
  db: D1Database, familyId: string, o: { q?: string; genre?: string; cursor?: number; limit?: number },
): Promise<BrowsePage> {
  const limit = Math.min(Math.max(Math.floor(o.limit ?? PAGE_SONGS), 1), PAGE_GROUPED);
  const genre = (o.genre ?? "").trim();
  const match = o.q ? matchQuery(o.q) : null;
  const cursor = Math.max(Math.floor(o.cursor ?? 0), 0);
  if (match) {
    const offset = Math.min(cursor, MAX_OFFSET);
    const r = await db.prepare(
      "SELECT t.*, t.rowid AS rid FROM tracks_fts JOIN tracks t ON t.rowid = tracks_fts.rowid " +
        `WHERE tracks_fts MATCH ? AND t.family_id = ? AND t.deleted = 0${genre ? " AND t.genre = ?" : ""} ` +
        "ORDER BY bm25(tracks_fts, 8, 4, 3, 1), t.rowid DESC LIMIT ? OFFSET ?",
    ).bind(match, familyId, ...(genre ? [genre] : []), limit + 1, offset).all<TrackRow & { rid: number }>();
    const more = r.results.length > limit && offset + limit < MAX_OFFSET;
    return { tracks: r.results.slice(0, limit).map(toTrack), next: more ? offset + limit : null };
  }
  const r = await db.prepare(
    "SELECT t.*, t.rowid AS rid FROM tracks t WHERE t.family_id = ? AND t.deleted = 0" +
      `${genre ? " AND t.genre = ?" : ""}${cursor > 0 ? " AND t.rowid < ?" : ""} ORDER BY t.rowid DESC LIMIT ?`,
  ).bind(familyId, ...(genre ? [genre] : []), ...(cursor > 0 ? [cursor] : []), limit + 1).all<TrackRow & { rid: number }>();
  const page = r.results.slice(0, limit);
  return { tracks: page.map(toTrack), next: r.results.length > limit ? page[page.length - 1]!.rid : null };
}

/** Every song of one album or one artist, for its page. `name` is the stored name exactly. */
export async function groupTracks(db: D1Database, familyId: string, kind: "album" | "artist", name: string): Promise<Track[]> {
  const col = kind === "album" ? "album" : "artist";
  const r = await db.prepare(
    `SELECT * FROM tracks WHERE family_id = ? AND deleted = 0 AND ${col} = ? ORDER BY album, track_no, title LIMIT 1000`,
  ).bind(familyId, name).all<TrackRow>();
  return r.results.map(toTrack);
}

/** Existing artist or album names that match what is being typed, most songs first (for the rename and edit dialogs). */
export async function nameSuggestions(db: D1Database, familyId: string, kind: "album" | "artist", q: string, limit = 8): Promise<string[]> {
  const match = matchQuery(q, kind);
  if (!match) return [];
  const col = kind === "album" ? "album" : "artist";
  const r = await db.prepare(
    `SELECT t.${col} AS n, COUNT(*) AS c FROM tracks_fts JOIN tracks t ON t.rowid = tracks_fts.rowid ` +
      `WHERE tracks_fts MATCH ? AND t.family_id = ? AND t.deleted = 0 AND t.${col} != '' GROUP BY t.${col} ORDER BY c DESC LIMIT ?`,
  ).bind(match, familyId, Math.min(Math.max(limit, 1), 20)).all<{ n: string; c: number }>();
  return r.results.map((x) => x.n);
}

/** A value that is costly to build and fine to be a few hours old. */
async function cached<T>(db: D1Database, familyId: string, key: string, ttl: number, build: () => Promise<T>): Promise<T> {
  const row = await db.prepare("SELECT json, built_at FROM family_cache WHERE family_id = ? AND key = ?").bind(familyId, key)
    .first<{ json: string; built_at: number }>();
  if (row && Date.now() - row.built_at < ttl) {
    try {
      return JSON.parse(row.json) as T;
    } catch {
      /* rebuilt below */
    }
  }
  const value = await build();
  await db.prepare(
    "INSERT INTO family_cache (family_id, key, json, built_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(family_id, key) DO UPDATE SET json = excluded.json, built_at = excluded.built_at",
  ).bind(familyId, key, JSON.stringify(value), Date.now()).run();
  return value;
}

/** The songs changed (a sync, an upload, a delete): the genre and most played lists are rebuilt on their next use. */
export async function clearLibraryCache(db: D1Database, familyId: string): Promise<void> {
  await db.prepare("DELETE FROM family_cache WHERE family_id = ? AND key IN ('genres', 'popular')").bind(familyId).run();
}

async function genreCounts(db: D1Database, familyId: string): Promise<{ name: string; count: number }[]> {
  const r = await db.prepare("SELECT genre, COUNT(*) AS n FROM tracks WHERE family_id = ? AND deleted = 0 GROUP BY genre")
    .bind(familyId).all<{ genre: string; n: number }>();
  return r.results.map((g) => ({ name: g.genre, count: g.n }));
}

/** The caller's own lists: loved songs, and loved songs not played for a while. */
async function userLists(db: D1Database, familyId: string, uid: string): Promise<{ top: string[]; rediscover: string[] }> {
  const top = await db.prepare(
    "SELECT r.track_id AS id FROM ratings r JOIN tracks t ON t.id = r.track_id AND t.family_id = ? AND t.deleted = 0 " +
      "WHERE r.uid = ? AND r.rating >= 4 ORDER BY r.rating DESC, r.updated_at DESC LIMIT 30",
  ).bind(familyId, uid).all<{ id: string }>();
  const since = Date.now() - REDISCOVER_AFTER_DAYS * 24 * HOUR;
  const again = await db.prepare(
    "SELECT r.track_id AS id FROM ratings r JOIN tracks t ON t.id = r.track_id AND t.family_id = ? AND t.deleted = 0 " +
      "WHERE r.uid = ? AND r.rating >= 4 AND NOT EXISTS " +
      "(SELECT 1 FROM plays p WHERE p.uid = r.uid AND p.track_id = r.track_id AND p.played_at > ?) ORDER BY random() LIMIT 30",
  ).bind(familyId, uid, since).all<{ id: string }>();
  return { top: top.results.map((x) => x.id), rediscover: again.results.map((x) => x.id) };
}

/** Records that the member opened the app (at most once an hour), so the nightly mixes are only rebuilt for people who did. */
export async function touchMember(db: D1Database, uid: string): Promise<void> {
  const now = Date.now();
  await db.prepare("UPDATE members SET last_seen_at = ? WHERE uid = ? AND last_seen_at < ?").bind(now, uid, now - HOUR).run();
}

/** The start page: today's mixes, the newest songs and a few lists, a few hundred rows in all. */
export async function homeData(db: D1Database, familyId: string, uid: string): Promise<HomeData> {
  await touchMember(db, uid);
  const [mixes, recentPage, popularIds, mine, genres, covers] = await Promise.all([
    getMixes(db, uid),
    browse(db, familyId, { limit: 120 }),
    cached(db, familyId, "popular", POPULAR_TTL, async () => (await popular(db, familyId, 90, 40)).map((p) => p.id)),
    cached(db, familyId, `u:${uid}`, USER_LISTS_TTL, () => userLists(db, familyId, uid)),
    cached(db, familyId, "genres", GENRES_TTL, () => genreCounts(db, familyId)),
    db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE family_id = ? AND source = 'r2' AND deleted = 0 AND art_key IS NULL AND art_tried = 0")
      .bind(familyId).first<{ n: number }>(),
  ]);
  const have = new Set(recentPage.tracks.map((t) => t.id));
  const wanted = [...mixes.flatMap((m) => m.trackIds), ...popularIds, ...mine.top, ...mine.rediscover].filter((id) => !have.has(id));
  const extra = await tracksByIds(db, familyId, wanted);
  const visible = new Set([...have, ...extra.map((t) => t.id)]);
  const keep = (ids: string[]) => ids.filter((id) => visible.has(id));
  const mixInfo: MixInfo[] = mixes.map((m) => ({ daypart: m.daypart, title: m.title, intro: m.intro, generatedAt: m.generatedAt, trackIds: keep(m.trackIds) }));
  return {
    mixes: mixInfo,
    recent: recentPage.tracks,
    lists: { popular: keep(popularIds), top: keep(mine.top), rediscover: keep(mine.rediscover) },
    tracks: extra,
    genres: genres.filter((g) => g.name !== "").sort((a, b) => b.count - a.count),
    songs: genres.reduce((s, g) => s + g.count, 0),
    missingCovers: covers?.n ?? 0,
  };
}
