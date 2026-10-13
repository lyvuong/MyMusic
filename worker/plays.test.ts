/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { popular, recordPlays, recordSkips } from "./plays";
import { loadRows } from "./suggest";

/** The real schema (every migration, in order) in an in-memory SQLite behind the small part of D1's API the code uses. */
function database() {
  const sql = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sql.exec(readFileSync(join(dir, f), "utf8"));
  const prepare = (query: string) => {
    let args: SQLInputValue[] = [];
    const stmt = {
      bind: (...a: SQLInputValue[]) => ((args = a), stmt),
      all: async () => ({ results: sql.prepare(query).all(...args) as unknown[] }),
      run: async () => {
        const r = sql.prepare(query).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  const db = { prepare, batch: async (s: { run: () => Promise<unknown> }[]) => Promise.all(s.map((x) => x.run())) } as unknown as D1Database;
  sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u1', 0), ('other', 'Other', 'u9', 0)");
  sql.exec(
    "INSERT INTO tracks (id, family_id, source, source_key, title, updated_at, deleted) VALUES " +
      "('t1', 'f', 'nas', 'k1', 'One', 0, 0), ('t2', 'f', 'nas', 'k2', 'Two', 0, 0), ('gone', 'f', 'nas', 'k3', 'Gone', 0, 1), ('x', 'other', 'nas', 'k4', 'X', 0, 0)",
  );
  return { sql, db };
}

describe("recordSkips", () => {
  it("keeps skips of the family's songs for the caller only, apart from plays", async () => {
    const { sql, db } = database();
    const at = Date.now() - 1000;
    const kept = await recordSkips(db, "f", "u1", [
      { trackId: "t1", at },
      { trackId: "t1", at }, // the same skip uploaded twice
      { trackId: "t2", at: at + 1 },
      { trackId: "gone", at },
      { trackId: "x", at },
      { trackId: "t1", at: Number.NaN },
    ]);
    expect(kept).toBe(3); // the duplicate is counted as kept by the batch but stored once
    expect(sql.prepare("SELECT uid, track_id FROM skips ORDER BY track_id").all()).toEqual([
      { uid: "u1", track_id: "t1" },
      { uid: "u1", track_id: "t2" },
    ]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM plays").get()).toEqual({ n: 0 });
  });

  it("does not make a skipped song more popular", async () => {
    const { db } = database();
    const now = Date.now();
    await recordPlays(db, "f", "u1", [{ trackId: "t1", at: now - 5000 }]);
    await recordSkips(db, "f", "u1", [{ trackId: "t2", at: now - 4000 }, { trackId: "t2", at: now - 3000 }]);
    expect(await popular(db, "f")).toEqual([{ id: "t1", plays: 1 }]);
  });

  it("reaches the mixes as the skipping member's own count, over the last 60 days", async () => {
    const { sql, db } = database();
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    sql.prepare("INSERT INTO skips (uid, track_id, family_id, skipped_at) VALUES (?, ?, ?, ?)").run("u1", "t1", "f", now - day);
    sql.prepare("INSERT INTO skips (uid, track_id, family_id, skipped_at) VALUES (?, ?, ?, ?)").run("u1", "t1", "f", now - 2 * day);
    sql.prepare("INSERT INTO skips (uid, track_id, family_id, skipped_at) VALUES (?, ?, ?, ?)").run("u1", "t2", "f", now - 70 * day);
    sql.prepare("INSERT INTO skips (uid, track_id, family_id, skipped_at) VALUES (?, ?, ?, ?)").run("u2", "t2", "f", now - day);
    const rows = await loadRows({ DB: db } as unknown as Env, "f", "u1");
    const skips = Object.fromEntries(rows.map((r) => [r.id, r.skips ?? 0]));
    expect(skips).toEqual({ t1: 2, t2: 0 });
  });
});
