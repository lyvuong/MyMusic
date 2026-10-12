/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { browse, foldWords, groupTracks, homeData, matchQuery, nameSuggestions, tracksByIds } from "./browse";

/** The real schema (every migration, in order) in an in-memory SQLite behind the small part of D1's API the code uses. */
function database() {
  const sql = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sql.exec(readFileSync(join(dir, f), "utf8"));
  const reads: string[] = [];
  const prepare = (query: string) => {
    let args: SQLInputValue[] = [];
    const stmt = {
      bind: (...a: SQLInputValue[]) => ((args = a), stmt),
      all: async () => ({ results: sql.prepare(query).all(...args) as unknown[] }),
      first: async () => (sql.prepare(query).get(...args) as unknown) ?? null,
      run: async () => {
        const r = sql.prepare(query).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
    reads.push(query);
    return stmt;
  };
  return { sql, db: { prepare, batch: async (s: { run: () => Promise<unknown> }[]) => Promise.all(s.map((x) => x.run())) } as unknown as D1Database, reads };
}

function seed(sql: DatabaseSync) {
  sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u1', 0), ('other', 'Other', 'u2', 0)");
  sql.exec("INSERT INTO members (uid, family_id, email, display_name, role, joined_at) VALUES ('u1', 'f', 'a@b', 'A', 'owner', 0)");
}

let n = 0;
function song(sql: DatabaseSync, t: { title: string; artist?: string; album?: string; genre?: string; deleted?: number; family?: string }) {
  n++;
  sql.prepare(
    "INSERT INTO tracks (id, family_id, source, source_key, title, artist, album, genre, updated_at, deleted) VALUES (?, ?, 'nas', ?, ?, ?, ?, ?, ?, ?)",
  ).run(`t${n}`, t.family ?? "f", `k${n}`, t.title, t.artist ?? "", t.album ?? "", t.genre ?? "", n, t.deleted ?? 0);
  return `t${n}`;
}

describe("foldWords and matchQuery", () => {
  it("drops accents, d with stroke and punctuation", () => {
    expect(foldWords("  Còn Yêu, Em  Mãi! ")).toEqual(["con", "yeu", "em", "mai"]);
    expect(foldWords("Đêm Nhớ")).toEqual(["dem", "nho"]);
  });
  it("makes every word a prefix and never lets typed text become syntax", () => {
    expect(matchQuery("con ye")).toBe('"con"* "ye"*');
    expect(matchQuery('"; DROP * OR')).toBe('"drop"* "or"*');
    expect(matchQuery("!!!")).toBeNull();
    expect(matchQuery("hoa", "artist")).toBe('artist : ("hoa"*)');
  });
});

describe("browse", () => {
  it("finds Vietnamese names typed without accents, in any word order", async () => {
    const { sql, db } = database();
    seed(sql);
    const a = song(sql, { title: "Còn Yêu Em Mãi", artist: "Khánh Ly", album: "Tình Ca" });
    song(sql, { title: "Đêm Nhớ", artist: "Ý Lan" });
    song(sql, { title: "Bad Moon Rising", artist: "CCR" });
    expect((await browse(db, "f", { q: "mai con" })).tracks.map((t) => t.id)).toEqual([a]);
    expect((await browse(db, "f", { q: "khanh ly" })).tracks.map((t) => t.id)).toEqual([a]);
    expect((await browse(db, "f", { q: "dem" })).tracks.map((t) => t.title)).toEqual(["Đêm Nhớ"]);
    expect((await browse(db, "f", { q: "tinh c" })).tracks.map((t) => t.id)).toEqual([a]);
  });

  it("follows renames, deletes and other families", async () => {
    const { sql, db } = database();
    seed(sql);
    const id = song(sql, { title: "Hoa Mua Xuan", artist: "Ai" });
    song(sql, { title: "Hoa Hong", family: "other" });
    song(sql, { title: "Hoa Cuc", deleted: 1 });
    expect((await browse(db, "f", { q: "hoa" })).tracks.map((t) => t.title)).toEqual(["Hoa Mua Xuan"]);
    sql.prepare("UPDATE tracks SET title = 'Hoa Mùa Xuân', artist = 'Nguyễn Văn' WHERE id = ?").run(id);
    expect((await browse(db, "f", { q: "xuan" })).tracks).toHaveLength(1);
    expect((await browse(db, "f", { q: "nguyen" })).tracks).toHaveLength(1);
    sql.prepare("UPDATE tracks SET title = 'Other', artist = '' WHERE id = ?").run(id);
    expect((await browse(db, "f", { q: "xuan" })).tracks).toHaveLength(0);
  });

  it("lists the newest songs first, a page at a time, and narrows by genre", async () => {
    const { sql, db } = database();
    seed(sql);
    for (let i = 1; i <= 25; i++) song(sql, { title: `Song ${i}`, genre: i % 5 === 0 ? "Bolero" : "Pop" });
    const first = await browse(db, "f", { limit: 10 });
    expect(first.tracks.map((t) => t.title)[0]).toBe("Song 25");
    expect(first.tracks).toHaveLength(10);
    const second = await browse(db, "f", { limit: 10, cursor: first.next! });
    expect(second.tracks[0]!.title).toBe("Song 15");
    const third = await browse(db, "f", { limit: 10, cursor: second.next! });
    expect(third.tracks).toHaveLength(5);
    expect(third.next).toBeNull();
    const bolero = await browse(db, "f", { genre: "Bolero", limit: 10 });
    expect(bolero.tracks.map((t) => t.title)).toEqual(["Song 25", "Song 20", "Song 15", "Song 10", "Song 5"]);
    expect((await browse(db, "f", { q: "song", genre: "Bolero", limit: 3 })).next).toBe(3);
  });

  it("does not scan the library: queries use an index", () => {
    const { sql } = database();
    seed(sql);
    const plan = (q: string, ...a: SQLInputValue[]) => (sql.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...a) as { detail: string }[]).map((r) => r.detail).join(" | ");
    const recent = plan("SELECT t.*, t.rowid AS rid FROM tracks t WHERE t.family_id = ? AND t.deleted = 0 ORDER BY t.rowid DESC LIMIT 61", "f");
    expect(recent).toContain("USING");
    expect(recent).not.toContain("TEMP B-TREE");
    const byGenre = plan("SELECT t.*, t.rowid AS rid FROM tracks t WHERE t.family_id = ? AND t.deleted = 0 AND t.genre = ? ORDER BY t.rowid DESC LIMIT 61", "f", "Pop");
    expect(byGenre).not.toContain("TEMP B-TREE");
    const album = plan("SELECT * FROM tracks WHERE family_id = ? AND deleted = 0 AND album = ?", "f", "x");
    expect(album).toContain("tracks_family_album");
    // What a rename does: it must find the songs by name, not by reading the family.
    const rename = plan("UPDATE tracks SET artist = ? WHERE family_id = ? AND deleted = 0 AND artist = ?", "y", "f", "x");
    expect(rename).toContain("tracks_family_artist");
    const count = plan("SELECT COUNT(*) FROM tracks WHERE family_id = ? AND deleted = 0 AND source = 'nas' AND artist = ?", "f", "x");
    expect(count).toContain("tracks_family_artist");
    const covers = plan("SELECT COUNT(*) FROM tracks WHERE family_id = ? AND source = 'r2' AND deleted = 0 AND art_key IS NULL AND art_tried = 0", "f");
    expect(covers).toContain("tracks_family_art_tried");
  });
});

describe("the rest of the browse API", () => {
  it("returns an album's songs in track order and resolves ids", async () => {
    const { sql, db } = database();
    seed(sql);
    sql.exec("INSERT INTO tracks (id, family_id, source, source_key, title, album, track_no, updated_at) VALUES ('b', 'f', 'nas', 'kb', 'Two', 'A', 2, 1), ('a', 'f', 'nas', 'ka', 'One', 'A', 1, 1)");
    expect((await groupTracks(db, "f", "album", "A")).map((t) => t.title)).toEqual(["One", "Two"]);
    expect((await tracksByIds(db, "f", ["b", "zzz", "a"])).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("suggests existing artist names while typing", async () => {
    const { sql, db } = database();
    seed(sql);
    song(sql, { title: "x", artist: "Khánh Ly" });
    song(sql, { title: "y", artist: "Khánh Ly" });
    song(sql, { title: "z", artist: "Khánh Hà" });
    expect(await nameSuggestions(db, "f", "artist", "khanh")).toEqual(["Khánh Ly", "Khánh Hà"]);
    expect(await nameSuggestions(db, "f", "artist", "ly")).toEqual(["Khánh Ly"]);
  });

  it("builds the home page from a few rows and remembers the member opened the app", async () => {
    const { sql, db } = database();
    seed(sql);
    const ids = [1, 2, 3].map((i) => song(sql, { title: `Song ${i}`, genre: "Pop" }));
    sql.prepare("INSERT INTO daily_mixes (uid, family_id, daypart, title, intro, track_ids, generated_at) VALUES ('u1', 'f', 'morning', 'Up', '', ?, 5)")
      .run(JSON.stringify([ids[0], "gone"]));
    sql.prepare("INSERT INTO ratings (uid, track_id, family_id, rating, updated_at) VALUES ('u1', ?, 'f', 5, 1)").run(ids[1]);
    const h = await homeData(db, "f", "u1");
    expect(h.recent.map((t) => t.title)).toEqual(["Song 3", "Song 2", "Song 1"]);
    expect(h.mixes[0]!.trackIds).toEqual([ids[0]]);
    expect(h.lists.top).toEqual([ids[1]]);
    expect(h.lists.rediscover).toEqual([ids[1]]);
    expect(h.genres).toEqual([{ name: "Pop", count: 3 }]);
    expect(h.songs).toBe(3);
    const seen = sql.prepare("SELECT last_seen_at FROM members WHERE uid = 'u1'").get() as { last_seen_at: number };
    expect(seen.last_seen_at).toBeGreaterThan(0);
  });
});
