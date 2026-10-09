import type { BeetsRun } from "../shared/types";

/**
 * Beets runs on the home server. The web app asks the Worker; the Worker records a run here and tells the home
 * server API (worker/home.ts) to start it. The server then reports progress and the result back to the Worker
 * (the /api/beets/agent/* endpoints) so the Family tab can show them.
 */

const LOG_MAX = 6000;
const STALE_MS = 2 * 3600 * 1000; // a run that never reported back (server or script died)
const KEEP = 20;
const ENRICH_STALE_MS = 4 * 3600 * 1000; // 2 h waiting for the import lock plus the enrich itself

interface RunRow {
  id: string; kind: BeetsRun["kind"]; status: BeetsRun["status"]; requested_at: number; started_at: number | null; finished_at: number | null;
  inbox_before: number | null; inbox_after: number | null; inbox_now: number | null; exit_code: number | null; log: string;
}

const toRun = (r: RunRow): BeetsRun => ({
  id: r.id, kind: r.kind, status: r.status, requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
  inboxBefore: r.inbox_before, inboxAfter: r.inbox_after, inboxNow: r.inbox_now, exitCode: r.exit_code, log: r.log,
});

/** The most recent runs of both kinds, newest first. */
export async function listRuns(db: D1Database, familyId: string, limit = 10): Promise<BeetsRun[]> {
  const rows = await db.prepare("SELECT * FROM beets_runs WHERE family_id = ? ORDER BY requested_at DESC LIMIT ?")
    .bind(familyId, limit).all<RunRow>();
  return rows.results.map(toRun);
}

const pruneRuns = (db: D1Database, familyId: string, kind: BeetsRun["kind"]) =>
  db.prepare("DELETE FROM beets_runs WHERE family_id = ? AND kind = ? AND id NOT IN (SELECT id FROM beets_runs WHERE family_id = ? AND kind = ? ORDER BY requested_at DESC LIMIT ?)")
    .bind(familyId, kind, familyId, kind, KEEP);

/**
 * Records a run that is about to start on the home server (status 'running'), or returns the one already going.
 * `created` tells the caller whether it still has to start the job.
 */
export async function beginRun(db: D1Database, familyId: string, uid: string, kind: "import" | "enrich"): Promise<{ run: BeetsRun; created: boolean }> {
  const now = Date.now();
  await db.prepare(
    "UPDATE beets_runs SET status = 'failed', finished_at = ?, log = 'Timed out: no report from the server.' " +
      "WHERE family_id = ? AND kind = ? AND status IN ('requested','running') AND COALESCE(started_at, requested_at) < ?",
  ).bind(now, familyId, kind, now - (kind === "import" ? STALE_MS : ENRICH_STALE_MS)).run();
  const open = await db.prepare("SELECT * FROM beets_runs WHERE family_id = ? AND kind = ? AND status IN ('requested','running') ORDER BY requested_at DESC LIMIT 1")
    .bind(familyId, kind).first<RunRow>();
  if (open) return { run: toRun(open), created: false };
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO beets_runs (id, family_id, kind, status, requested_by, requested_at, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?)")
      .bind(id, familyId, kind, uid, now, now),
    pruneRuns(db, familyId, kind),
  ]);
  return { run: toRun((await db.prepare("SELECT * FROM beets_runs WHERE id = ?").bind(id).first<RunRow>())!), created: true };
}

/** Marks a run failed because the home server could not be told to start it. */
export async function failRun(db: D1Database, id: string, message: string): Promise<void> {
  await db.prepare("UPDATE beets_runs SET status = 'failed', finished_at = ?, log = ? WHERE id = ? AND status IN ('requested','running')")
    .bind(Date.now(), message.slice(-LOG_MAX), id).run();
}

/** Live progress from the home server: files in the inbox when the run began and right now. */
export async function updateProgress(db: D1Database, id: string, before: number | null, now: number | null): Promise<boolean> {
  const res = await db.prepare("UPDATE beets_runs SET inbox_before = COALESCE(inbox_before, ?), inbox_now = ? WHERE id = ? AND status = 'running'")
    .bind(before, now, id).run();
  return (res.meta.changes ?? 0) > 0;
}

export interface RunReport {
  id: string; ok: boolean; inboxBefore: number | null; inboxAfter: number | null; exitCode: number | null; log: string;
}

/** Stores the result of a running run; false when the run is unknown or was not running. */
export async function finishRun(db: D1Database, r: RunReport): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE beets_runs SET status = ?, finished_at = ?, inbox_before = ?, inbox_after = ?, exit_code = ?, log = ? WHERE id = ? AND status = 'running'",
  ).bind(r.ok ? "done" : "failed", Date.now(), r.inboxBefore, r.inboxAfter, r.exitCode, r.log.slice(-LOG_MAX), r.id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The nightly enrich script (scripts/unraid/beets-enrich.sh) announces itself (it may then wait for the import lock)
 * so a night that never got going is visible. It belongs to the family that owns the music, which is the only one
 * the server serves.
 */
export async function startEnrich(db: D1Database): Promise<string | null> {
  const fam = await db.prepare("SELECT id FROM families ORDER BY created_at LIMIT 1").first<{ id: string }>();
  if (!fam) return null;
  const now = Date.now();
  await db.prepare("UPDATE beets_runs SET status = 'failed', finished_at = ?, log = 'Timed out: no report from the server.' WHERE kind = 'enrich' AND status = 'running' AND started_at < ?")
    .bind(now, now - ENRICH_STALE_MS).run();
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO beets_runs (id, family_id, kind, status, requested_by, requested_at, started_at) VALUES (?, ?, 'enrich', 'running', 'agent', ?, ?)")
      .bind(id, fam.id, now, now),
    pruneRuns(db, fam.id, "enrich"),
  ]);
  return id;
}

/** Constant-time comparison of the home server's shared key. */
export function agentKeyOk(env: Env, given: string | undefined): boolean {
  const key = env.BEETS_AGENT_KEY;
  if (!key || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(key);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
