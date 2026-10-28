/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyPendingPlaylists, queueForPlaylist } from "./ytplaylist";

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
  const db = { prepare, batch: async (s: { run: () => Promise<unknown> }[]) => { for (const x of s) await x.run(); } } as unknown as D1Database;
  sql.exec("INSERT INTO families (id, name, owner_uid, created_at) VALUES ('f', 'Fam', 'u1', 0)");
  return { sql, db };
}

const addTrack = (sql: DatabaseSync, id: string, title: string, artist: string) =>
  sql.exec(`INSERT INTO tracks (id, family_id, source, source_key, title, artist, updated_at, deleted) VALUES ('${id}', 'f', 'nas', 'k${id}', '${title}', '${artist}', 0, 0)`);
const listed = (sql: DatabaseSync, name: string) =>
  sql.prepare("SELECT t.title FROM playlists p JOIN playlist_tracks pt ON pt.playlist_id = p.id JOIN tracks t ON t.id = pt.track_id WHERE p.name = ? AND p.deleted = 0 ORDER BY pt.pos").all(name).map((r) => r.title);

describe("applyPendingPlaylists", () => {
  it("creates the playlist, adds songs once they are in the library, in order, and waits for the rest", async () => {
    const { sql, db } = database();
    await queueForPlaylist(db, "f", "u1", "Road trip", "B song", "Band");
    await queueForPlaylist(db, "f", "u1", "Road trip", "A song", "Band");
    await queueForPlaylist(db, "f", "u1", "Road trip", "Late", "Band");
    addTrack(sql, "t1", "A song", "Band");
    addTrack(sql, "t2", "B song", "Band");
    await applyPendingPlaylists(db, "f");
    expect(listed(sql, "Road trip")).toEqual(["B song", "A song"]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM pending_playlist").get()).toEqual({ n: 1 });

    addTrack(sql, "t3", "Late", "Band");
    await applyPendingPlaylists(db, "f");
    expect(listed(sql, "Road trip")).toEqual(["B song", "A song", "Late"]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM playlists").get()).toEqual({ n: 1 });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM pending_playlist").get()).toEqual({ n: 0 });
  });

  it("adds to an existing playlist of the same name without duplicating a song", async () => {
    const { sql, db } = database();
    addTrack(sql, "t1", "A song", "Band");
    addTrack(sql, "t2", "B song", "Band");
    sql.exec("INSERT INTO playlists (id, family_id, owner_uid, name, shared, updated_at, deleted) VALUES ('p1', 'f', 'u1', 'Mix', 0, 0, 0)");
    sql.exec("INSERT INTO playlist_tracks (playlist_id, track_id, pos) VALUES ('p1', 't1', 0)");
    await queueForPlaylist(db, "f", "u1", "Mix", "A song", "Band");
    await queueForPlaylist(db, "f", "u1", "Mix", "B song", "Band");
    await applyPendingPlaylists(db, "f");
    expect(listed(sql, "Mix")).toEqual(["A song", "B song"]);
  });
});
