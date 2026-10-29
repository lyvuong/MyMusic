/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestAi } from "../shared/aireview";
import type { Track } from "../shared/types";
import { recheckAi, rememberSource, setAi, songsWithSource } from "./aisongs";

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
  for (const [id, title, ai] of [["a", "One", 0], ["b", "Two", 1], ["c", "Three", 0]] as const) {
    sql.exec(`INSERT INTO tracks (id, family_id, source, source_key, title, artist, album, duration, updated_at, deleted, ai) VALUES ('${id}', 'f', 'nas', 'k${id}', '${title}', 'Band', 'Al', 200, 0, 0, ${ai})`);
  }
  return { sql, db };
}

describe("setAi", () => {
  it("marks and clears songs, counts only real changes and bumps updated_at", async () => {
    const { sql, db } = database();
    expect(await setAi(db, "f", ["a", "b", "nope"], true)).toBe(1);
    expect(sql.prepare("SELECT id FROM tracks WHERE ai = 1 ORDER BY id").all()).toEqual([{ id: "a" }, { id: "b" }]);
    expect((sql.prepare("SELECT updated_at FROM tracks WHERE id = 'a'").get() as { updated_at: number }).updated_at).toBeGreaterThan(0);
    expect(await setAi(db, "f", ["a", "b"], false)).toBe(2);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM tracks WHERE ai = 1").get()).toEqual({ n: 0 });
  });

  it("leaves another family's songs alone", async () => {
    const { db } = database();
    expect(await setAi(db, "other", ["a"], true)).toBe(0);
  });
});

describe("YouTube sources", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds songs by title and artist and asks YouTube about their link", async () => {
    const { db } = database();
    await rememberSource(db, "f", "https://youtu.be/abc", "One", "Band");
    expect(await songsWithSource(db, "f")).toEqual(["a"]);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ title: "One", artist: "Band", album: "", duration: 100, thumbnail: null, tooLong: false, aiLabel: true, aiHint: false })));
    const env = { DB: db, HOME_API_URL: "https://home.test", BEETS_AGENT_KEY: "k" } as unknown as Env;
    expect(await recheckAi(env, "f", ["a", "b"])).toEqual([
      { id: "a", label: true, hint: false },
      { id: "b", label: false, hint: false, error: "No YouTube link is known for this song." },
    ]);
  });

  it("is filled from the run history by the migration", () => {
    const sql = new DatabaseSync(":memory:");
    const dir = join(process.cwd(), "migrations");
    const files = readdirSync(dir).filter((x) => x.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0026")) sql.exec(readFileSync(join(dir, f), "utf8"));
    sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u1', 0)");
    sql.exec(`INSERT INTO beets_runs (id, family_id, kind, status, requested_by, requested_at, payload) VALUES
      ('r1', 'f', 'youtube', 'done', 'u1', 5, '{"url":"https://youtu.be/x","title":"T","artist":"A","album":"YouTube"}'),
      ('r2', 'f', 'youtube', 'failed', 'u1', 6, '{"url":"https://youtu.be/y","title":"T2","artist":"A"}')`);
    for (const f of files.filter((x) => x >= "0026")) sql.exec(readFileSync(join(dir, f), "utf8"));
    expect(sql.prepare("SELECT url, title, artist FROM youtube_sources").all()).toEqual([{ url: "https://youtu.be/x", title: "T", artist: "A" }]);
  });
});

describe("suggestAi", () => {
  const t = (id: string, artist: string, album: string, ai: boolean, deleted = false) =>
    ({ id, title: id, artist, album, ai, deleted }) as unknown as Track;

  it("offers the unmarked songs of partly marked artists and albums, likely ones first", () => {
    const out = suggestAi([
      t("1", "Suno Band", "A", true), t("2", "Suno Band", "A", true), t("3", "Suno Band", "B", false),
      t("4", "Real Band", "C", true), t("5", "Real Band", "C", false), t("6", "Real Band", "D", false), t("7", "Real Band", "E", false),
      t("8", "All Marked", "F", true), t("9", "None Marked", "G", false), t("10", "Suno Band", "B", false, true),
    ]);
    expect(out.map((s) => `${s.kind}:${s.name}`)).toEqual(["artist:Suno Band", "album:C — Real Band", "artist:Real Band"]);
    expect(out[0]).toMatchObject({ ai: 2, total: 3, likely: true });
    expect(out[0]!.rest.map((x) => x.id)).toEqual(["3"]);
    expect(out[2]).toMatchObject({ likely: false });
  });
});
