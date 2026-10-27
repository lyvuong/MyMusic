/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fillGenres, setArtistGenre } from "./genres";
import { loadRows } from "./suggest";

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
      run: async () => {
        const r = sql.prepare(query).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  const db = { prepare, batch: async (s: { run: () => Promise<unknown> }[]) => Promise.all(s.map((x) => x.run())) } as unknown as D1Database;
  return { sql, db };
}

let n = 0;
function song(sql: DatabaseSync, title: string, artist: string, genre = "") {
  n++;
  sql.prepare("INSERT INTO tracks (id, family_id, source, source_key, title, artist, genre, updated_at) VALUES (?, 'f', 'nas', ?, ?, ?, ?, ?)")
    .run(`g${n}`, `k${n}`, title, artist, genre, n);
  return `g${n}`;
}

function setup() {
  const { sql, db } = database();
  sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u', 0)");
  return { sql, db };
}

describe("fillGenres", () => {
  it("gives an artist's untagged songs the genre of their tagged ones, without the AI", async () => {
    const { sql, db } = setup();
    song(sql, "A", "Band", "Rock");
    song(sql, "B", "Band", "Rock");
    song(sql, "C", "Band", "Pop");
    const bare = song(sql, "D", "Band");
    const r = await fillGenres({ DB: db } as unknown as Env, "f");
    expect(r).toEqual({ filled: 1, done: true });
    const row = (await loadRows({ DB: db } as unknown as Env, "f", "u")).find((x) => x.id === bare)!;
    expect(row.genre).toBe("Rock");
  });

  it("asks the AI about the rest, accepts only listed genres and never asks twice", async () => {
    const { sql, db } = setup();
    const a = song(sql, "Con Yeu Em Mai", "Lam Truong");
    const b = song(sql, "Something", "Nobody Known");
    const c = song(sql, "Else", "Made Up Band");
    let calls = 0;
    const AI = {
      run: async (_m: string, input: { messages: { content: string }[] }) => {
        calls++;
        const text = input.messages[1].content;
        const n = (artist: string) => Number(new RegExp(`(\\d+)\\|${artist}\\|`).exec(text)![1]);
        return { response: { artists: [
          { n: n("Lam Truong"), genre: "vietnamese pop" },
          { n: n("Nobody Known"), genre: "Unknown" },
          { n: n("Made Up Band"), genre: "Polka Fusion" }, // not on the list: counts as unknown
        ] } };
      },
    };
    const env = { DB: db, AI } as unknown as Env;
    expect(await fillGenres(env, "f")).toEqual({ filled: 1, done: true });
    const genre = async (id: string) => (await loadRows(env, "f", "u")).find((x) => x.id === id)!.genre;
    expect(await genre(a)).toBe("Vietnamese Pop");
    expect(await genre(b)).toBe("");
    expect(await genre(c)).toBe("");
    expect(calls).toBe(1);
    await fillGenres(env, "f");
    expect(calls).toBe(1); // unknown artists are remembered
  });

  it("keeps a song's own genre over its artist's", async () => {
    const { sql, db } = setup();
    const own = song(sql, "A", "Band", "Jazz");
    song(sql, "B", "Band", "Rock");
    song(sql, "C", "Band", "Rock");
    song(sql, "D", "Band");
    await fillGenres({ DB: db } as unknown as Env, "f");
    expect((await loadRows({ DB: db } as unknown as Env, "f", "u")).find((x) => x.id === own)!.genre).toBe("Jazz");
  });
});

describe("setArtistGenre", () => {
  it("sets a genre as the user's own (not overwritten by the app) and clears it when empty", async () => {
    const { sql, db } = setup();
    song(sql, "A", "Band");
    sql.prepare("INSERT INTO family_cache (family_id, key, json, built_at) VALUES ('f', 'genres', '[]', 1)").run();
    await setArtistGenre(db, "f", "Band", "vietnamese pop");
    expect(sql.prepare("SELECT genre, source FROM artist_genres WHERE artist = 'Band'").get()).toMatchObject({ genre: "Vietnamese Pop", source: "user" });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM family_cache WHERE key = 'genres'").get()).toMatchObject({ n: 0 });
    await fillGenres({ DB: db } as unknown as Env, "f");
    expect(sql.prepare("SELECT source FROM artist_genres WHERE artist = 'Band'").get()).toMatchObject({ source: "user" });
    await setArtistGenre(db, "f", "Band", "");
    expect(sql.prepare("SELECT COUNT(*) AS n FROM artist_genres").get()).toMatchObject({ n: 0 });
  });
});
