/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { judgeSongs, wellKnown } from "./fame";
import { tasteProfile } from "./taste";

function database() {
  const sql = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sql.exec(readFileSync(join(dir, f), "utf8"));
  const prepare = (query: string) => {
    let args: SQLInputValue[] = [];
    const stmt = {
      bind: (...a: SQLInputValue[]) => ((args = a), stmt),
      all: async () => ({ results: sql.prepare(query).all(...args) as unknown[] }),
      run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
    };
    return stmt;
  };
  const db = { prepare, batch: async (s: { run: () => Promise<unknown> }[]) => Promise.all(s.map((x) => x.run())) } as unknown as D1Database;
  sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u1', 0)");
  const add = (id: string, title: string, artist: string) =>
    sql.prepare("INSERT INTO tracks (id, family_id, source, source_key, title, artist, updated_at, deleted) VALUES (?, 'f', 'nas', ?, ?, ?, 0, 0)").run(id, `k${id}`, title, artist);
  return { sql, db, add };
}

describe("judgeSongs", () => {
  it("stores what the AI says once, clamps scores, and does not ask about the same songs again", async () => {
    const { sql, db, add } = database();
    add("a", "Hit Song", "Big Star");
    add("b", "B Side", "Nobody");
    add("c", "Third", "Somebody");
    let asked = 0;
    const AI = { run: async () => (asked++, { response: { songs: [{ n: 1, s: 3 }, { n: 2, s: 0 }, { n: 3, s: 9 }] } }) };
    const first = await judgeSongs({ DB: db, AI } as unknown as Env, "f");
    expect(first).toEqual({ judged: 3, done: true });
    expect(sql.prepare("SELECT track_id, score FROM song_fame ORDER BY track_id").all()).toEqual([
      { track_id: "a", score: 3 }, { track_id: "b", score: 0 }, { track_id: "c", score: 3 },
    ]);
    expect(await wellKnown(db, "f", 10)).toEqual(expect.arrayContaining(["a", "c"]));
    expect(await wellKnown(db, "f", 10)).not.toContain("b");
    const again = await judgeSongs({ DB: db, AI } as unknown as Env, "f");
    expect(again).toEqual({ judged: 0, done: true });
    expect(asked).toBe(1);
  });

  it("leaves songs unjudged when the AI fails, so they are asked again next time", async () => {
    const { sql, db, add } = database();
    add("a", "Song", "Artist");
    const AI = { run: async () => { throw new Error("busy"); } };
    expect(await judgeSongs({ DB: db, AI } as unknown as Env, "f")).toEqual({ judged: 0, done: false });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM song_fame").get()).toEqual({ n: 0 });
  });
});

describe("tasteProfile", () => {
  const r = (id: string, artist: string, rating: number | null, myPlays = 0, skips = 0) => ({ id, title: id, artist, rating, myPlays, skips });

  it("picks the top three artists and songs from ratings and plays, ignoring disliked songs and skipped ones", () => {
    const p = tasteProfile([
      r("s1", "A", 5, 4), r("s2", "A", 5), r("s3", "A", 4),
      r("s4", "B", 5), r("s5", "B", null, 8),
      r("s6", "C", 4), r("s7", "D", 2, 20), r("s8", "E", null, 0, 3), r("s9", "F", 3),
    ]);
    expect(p.artists.map((a) => a.name)).toEqual(["A", "B", "C"]);
    expect(p.artists[0]).toEqual({ name: "A", songs: 3 });
    expect(p.tracks.map((t) => t.id)).toEqual(["s1", "s5", "s2"]);
  });

  it("is empty when there is nothing to go on", () => {
    expect(tasteProfile([r("x", "A", null), r("y", "B", 1)])).toEqual({ artists: [], tracks: [] });
  });
});
