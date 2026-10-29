/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DupSong } from "../shared/types";
import { best, groupDuplicates, resolveDuplicates, titleKey } from "./duplicates";

let n = 0;
const song = (title: string, artist: string, album: string, duration: number, extra: Partial<DupSong> = {}): DupSong => ({
  id: `s${++n}`, source: "nas", title, artist, album, duration, trackNo: 1, size: duration * 40000, lists: 0, rating: 0, plays: 0, ...extra,
});

describe("titleKey", () => {
  it("drops remaster and year notes but keeps live and remix", () => {
    expect(titleKey("Hotel California (2013 Remaster)")).toBe("hotel california");
    expect(titleKey("Hotel California - 2013 Remaster")).toBe("hotel california");
    expect(titleKey("Hotel California (Live)")).toBe("hotel california (live)".replace(/[()]/g, "").trim());
    expect(titleKey("Hotel California (Live)")).not.toBe(titleKey("Hotel California"));
    expect(titleKey("Song [Remix]")).not.toBe(titleKey("Song"));
  });
});

describe("groupDuplicates", () => {
  it("groups the same song on two albums and ignores 'The' and accents in the artist", () => {
    const a = song("Hotel California", "Eagles", "Hotel California", 391);
    const b = song("Hotel California (2013 Remaster)", "The Eagles", "The Very Best Of - Disc 1", 391);
    const other = song("Desperado", "Eagles", "Desperado", 214);
    const g = groupDuplicates([a, b, other]);
    expect(g).toHaveLength(1);
    expect(g[0]!.songs.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("keeps a live version and a much longer take apart from the studio one", () => {
    const studio = song("Tin Man", "America", "History", 213);
    const live = song("Tin Man (Live)", "America", "The Best Of America", 220);
    const longer = song("Tin Man", "America", "Live Bootleg", 330);
    expect(groupDuplicates([studio, live, longer])).toEqual([]);
  });

  it("suggests the copy that is in a playlist, then a real album over a compilation", () => {
    const comp = song("Sandman", "America", "America's Greatest Hits", 190);
    const album = song("Sandman", "America", "America", 190);
    expect(best([comp, album]).id).toBe(album.id);
    const inList = { ...comp, lists: 2 };
    expect(best([inList, album]).id).toBe(comp.id);
  });
});

/** The real schema in an in-memory SQLite behind the small part of D1's API the code uses. */
function database() {
  const sql = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sql.exec(readFileSync(join(dir, f), "utf8"));
  const prepare = (query: string) => {
    let args: SQLInputValue[] = [];
    const stmt = {
      bind: (...a: SQLInputValue[]) => ((args = a), stmt),
      all: async () => ({ results: sql.prepare(query).all(...args) as unknown[] }),
      first: async () => (sql.prepare(query).get(...args) as unknown) ?? null,
      run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
    };
    return stmt;
  };
  const db = { prepare, batch: async (s: { run: () => Promise<unknown> }[]) => { for (const x of s) await x.run(); } } as unknown as D1Database;
  sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u1', 0)");
  for (const [id, album] of [["keep", "Album"], ["dup", "Greatest Hits"]]) {
    sql.exec(`INSERT INTO tracks (id, family_id, source, source_key, title, artist, album, duration, updated_at, deleted) VALUES ('${id}', 'f', 'nas', 'k${id}', 'Song', 'Band', '${album}', 200, 0, 0)`);
  }
  return { sql, db };
}

describe("resolveDuplicates", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = (db: D1Database) => ({ DB: db, HOME_API_URL: "https://home.test", BEETS_AGENT_KEY: "k" }) as unknown as Env;

  it("moves playlist places and ratings to the kept copy, then hides the deleted one", async () => {
    const { sql, db } = database();
    sql.exec("INSERT INTO playlists (id, family_id, owner_uid, name, shared, updated_at, deleted) VALUES ('p1', 'f', 'u1', 'A', 0, 0, 0), ('p2', 'f', 'u1', 'B', 0, 0, 0)");
    sql.exec("INSERT INTO playlist_tracks (playlist_id, track_id, pos) VALUES ('p1', 'dup', 0), ('p2', 'dup', 0), ('p2', 'keep', 1)");
    sql.exec("INSERT INTO ratings (uid, track_id, family_id, rating, updated_at) VALUES ('u1', 'dup', 'f', 4, 0)");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ title: "Song", album: "Greatest Hits", status: "deleted", why: "" }] }))));
    const r = await resolveDuplicates(env(db), "f", [{ keep: "keep", remove: ["dup"] }]);
    expect(r).toEqual({ removed: ["dup"], failed: [] });
    expect(sql.prepare("SELECT playlist_id, track_id FROM playlist_tracks ORDER BY playlist_id, pos").all().map((x) => `${x.playlist_id}:${x.track_id}`)).toEqual(["p1:keep", "p2:keep"]);
    expect(sql.prepare("SELECT track_id FROM ratings").all()).toEqual([{ track_id: "keep" }]);
    expect(sql.prepare("SELECT deleted FROM tracks WHERE id = 'dup'").get()).toEqual({ deleted: 1 });
    expect(sql.prepare("SELECT deleted FROM tracks WHERE id = 'keep'").get()).toEqual({ deleted: 0 });
  });

  it("leaves a copy alone when the server did not delete it", async () => {
    const { sql, db } = database();
    sql.exec("INSERT INTO playlists (id, family_id, owner_uid, name, shared, updated_at, deleted) VALUES ('p1', 'f', 'u1', 'A', 0, 0, 0)");
    sql.exec("INSERT INTO playlist_tracks (playlist_id, track_id, pos) VALUES ('p1', 'dup', 0)");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ title: "Song", album: "Greatest Hits", status: "skipped", why: "several songs share these names" }] }))));
    const r = await resolveDuplicates(env(db), "f", [{ keep: "keep", remove: ["dup"] }]);
    expect(r.removed).toEqual([]);
    expect(r.failed).toEqual([{ id: "dup", why: "several songs share these names" }]);
    expect(sql.prepare("SELECT track_id FROM playlist_tracks").all()).toEqual([{ track_id: "dup" }]);
    expect(sql.prepare("SELECT deleted FROM tracks WHERE id = 'dup'").get()).toEqual({ deleted: 0 });
  });
});
