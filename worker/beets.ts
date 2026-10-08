import type { BeetsRun } from "../shared/types";

/**
 * Beets import runs. The Worker cannot reach the home server, so the server pulls: the web app requests a run
 * (status 'requested'), the polling script claims it ('running') and reports the result ('done' / 'failed').
 */

const LOG_MAX = 6000;
const STALE_MS = 2 * 3600 * 1000; // a claimed run that never reported back (script or server died)
const KEEP = 20;

interface RunRow {
  id: string; status: BeetsRun["status"]; requested_at: number; started_at: number | null; finished_at: number | null;
  inbox_before: number | null; inbox_after: number | null; exit_code: number | null; log: string;
}

const toRun = (r: RunRow): BeetsRun => ({
  id: r.id, status: r.status, requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
  inboxBefore: r.inbox_before, inboxAfter: r.inbox_after, exitCode: r.exit_code, log: r.log,
});

/** The most recent runs, newest first. */
export async function listRuns(db: D1Database, familyId: string, limit = 5): Promise<BeetsRun[]> {
  const rows = await db.prepare("SELECT * FROM beets_runs WHERE family_id = ? ORDER BY requested_at DESC LIMIT ?")
    .bind(familyId, limit).all<RunRow>();
  return rows.results.map(toRun);
}

/** Queues a run, or returns the one already waiting or in progress. */
export async function requestRun(db: D1Database, familyId: string, uid: string): Promise<BeetsRun> {
  const now = Date.now();
  await db.prepare("UPDATE beets_runs SET status = 'failed', finished_at = ?, log = 'Timed out: no report from the server.' WHERE family_id = ? AND status IN ('requested','running') AND requested_at < ?")
    .bind(now, familyId, now - STALE_MS).run();
  const open = await db.prepare("SELECT * FROM beets_runs WHERE family_id = ? AND status IN ('requested','running') ORDER BY requested_at DESC LIMIT 1")
    .bind(familyId).first<RunRow>();
  if (open) return toRun(open);
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO beets_runs (id, family_id, status, requested_by, requested_at) VALUES (?, ?, 'requested', ?, ?)").bind(id, familyId, uid, now),
    db.prepare("DELETE FROM beets_runs WHERE family_id = ? AND id NOT IN (SELECT id FROM beets_runs WHERE family_id = ? ORDER BY requested_at DESC LIMIT ?)")
      .bind(familyId, familyId, KEEP),
  ]);
  return toRun((await db.prepare("SELECT * FROM beets_runs WHERE id = ?").bind(id).first<RunRow>())!);
}

/** Hands the oldest requested run to the polling script and marks it running; null when nothing is waiting. */
export async function claimRun(db: D1Database): Promise<string | null> {
  const r = await db.prepare(
    "UPDATE beets_runs SET status = 'running', started_at = ? " +
      "WHERE id = (SELECT id FROM beets_runs WHERE status = 'requested' ORDER BY requested_at LIMIT 1) AND status = 'requested' RETURNING id",
  ).bind(Date.now()).first<{ id: string }>();
  return r?.id ?? null;
}

export interface RunReport {
  id: string; ok: boolean; inboxBefore: number | null; inboxAfter: number | null; exitCode: number | null; log: string;
}

/** Stores the result of a claimed run; false when the run is unknown or was not running. */
export async function finishRun(db: D1Database, r: RunReport): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE beets_runs SET status = ?, finished_at = ?, inbox_before = ?, inbox_after = ?, exit_code = ?, log = ? WHERE id = ? AND status = 'running'",
  ).bind(r.ok ? "done" : "failed", Date.now(), r.inboxBefore, r.inboxAfter, r.exitCode, r.log.slice(-LOG_MAX), r.id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Constant-time comparison of the polling script's shared key. */
export function agentKeyOk(env: Env, given: string | undefined): boolean {
  const key = env.BEETS_AGENT_KEY;
  if (!key || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(key);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
