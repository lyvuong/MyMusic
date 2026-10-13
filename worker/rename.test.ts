/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { renameGroup } from "./library";

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
  sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u', 0)");
  return { sql, db: { prepare } as unknown as D1Database };
}

let n = 0;
const song = (sql: DatabaseSync, artist: string) =>
  sql.prepare("INSERT INTO tracks (id, family_id, source, source_key, title, artist, updated_at) VALUES (?, 'f', 'nas', ?, 't', ?, 1)").run(`r${++n}`, `k${n}`, artist);

describe("renameGroup and Unicode forms", () => {
  const nfd = "Khánh Hà";
  const nfc = nfd.normalize("NFC");

  it("turns a decomposed name into its composed form (it used to land on itself and change nothing)", async () => {
    const { sql, db } = database();
    song(sql, nfd);
    song(sql, nfd);
    const r = await renameGroup(db, "f", "artist", nfd, nfc);
    expect(r.updated).toBe(2);
    const names = (sql.prepare("SELECT DISTINCT artist FROM tracks").all() as { artist: string }[]).map((x) => x.artist);
    expect(names).toEqual([nfc]);
    expect(names[0] === nfc).toBe(true);
  });

  it("still merges into an existing decomposed spelling when renaming a different name to it", async () => {
    const { sql, db } = database();
    song(sql, nfd);
    song(sql, "Khanh Ha");
    const r = await renameGroup(db, "f", "artist", "Khanh Ha", nfc);
    expect(r.target).toBe(nfd);
    expect(r.updated).toBe(1);
  });
});
