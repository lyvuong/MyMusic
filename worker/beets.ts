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
/** A run younger than this is never judged "gone" from the server's list of jobs: it may just be starting. */
const START_GRACE_MS = 60 * 1000;

interface RunRow {
  id: string; kind: BeetsRun["kind"]; status: BeetsRun["status"]; requested_at: number; started_at: number | null; finished_at: number | null;
  inbox_before: number | null; inbox_after: number | null; inbox_now: number | null; exit_code: number | null; log: string;
  payload: string | null;
}

/** What a queued YouTube link carries until the server downloads it. */
export interface YoutubePayload { url: string; title: string; artist: string; album: string }

const parsePayload = (raw: string | null): YoutubePayload | null => {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<YoutubePayload>;
    return typeof p.url === "string" && typeof p.title === "string" && typeof p.artist === "string"
      ? { url: p.url, title: p.title, artist: p.artist, album: typeof p.album === "string" ? p.album : "" }
      : null;
  } catch {
    return null;
  }
};

const toRun = (r: RunRow): BeetsRun => {
  const p = parsePayload(r.payload);
  return {
    id: r.id, kind: r.kind, status: r.status, requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
    inboxBefore: r.inbox_before, inboxAfter: r.inbox_after, inboxNow: r.inbox_now, exitCode: r.exit_code, log: r.log,
    label: p ? `${p.artist} – ${p.title}` : null,
  };
};

/** The most recent runs of both kinds, newest first. */
export async function listRuns(db: D1Database, familyId: string, limit = 30): Promise<BeetsRun[]> {
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
export async function beginRun(db: D1Database, familyId: string, uid: string, kind: BeetsRun["kind"]): Promise<{ run: BeetsRun; created: boolean }> {
  const now = Date.now();
  await db.prepare(
    "UPDATE beets_runs SET status = 'failed', finished_at = ?, log = 'Timed out: no report from the server.' " +
      "WHERE family_id = ? AND kind = ? AND status IN ('requested','running') AND COALESCE(started_at, requested_at) < ?",
  ).bind(now, familyId, kind, now - (kind === "enrich" ? ENRICH_STALE_MS : STALE_MS)).run();
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
 * The nightly enrich script (scripts/unraid/beets-enrich.sh) and the home server's inbox watcher announce a run (it
 * may then wait for the import lock) so a night that never got going is visible. It belongs to the family that owns
 * the music, which is the only one the server serves.
 */
export async function startAgentRun(db: D1Database, kind: "import" | "enrich"): Promise<string | null> {
  const fam = await db.prepare("SELECT id FROM families ORDER BY created_at LIMIT 1").first<{ id: string }>();
  if (!fam) return null;
  const now = Date.now();
  await db.prepare("UPDATE beets_runs SET status = 'failed', finished_at = ?, log = 'Timed out: no report from the server.' WHERE kind = ? AND status = 'running' AND started_at < ?")
    .bind(now, kind, now - (kind === "enrich" ? ENRICH_STALE_MS : STALE_MS)).run();
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO beets_runs (id, family_id, kind, status, requested_by, requested_at, started_at) VALUES (?, ?, ?, 'running', 'agent', ?, ?)")
      .bind(id, fam.id, kind, now, now),
    pruneRuns(db, fam.id, kind),
  ]);
  return id;
}

/** One run by id. */
export async function getRun(db: D1Database, id: string): Promise<BeetsRun | null> {
  const r = await db.prepare("SELECT * FROM beets_runs WHERE id = ?").bind(id).first<RunRow>();
  return r ? toRun(r) : null;
}

/**
 * Puts a YouTube link in the queue (status 'requested'), or returns the open run for the same link.
 * Links are not coalesced otherwise: any number can wait, the server downloads a few at a time.
 */
export async function enqueueYoutube(db: D1Database, familyId: string, uid: string, p: YoutubePayload): Promise<{ run: BeetsRun; created: boolean }> {
  const now = Date.now();
  await db.prepare(
    "UPDATE beets_runs SET status = 'failed', finished_at = ?, log = 'Timed out: no report from the server.' " +
      "WHERE kind = 'youtube' AND status IN ('requested','running') AND COALESCE(started_at, requested_at) < ?",
  ).bind(now, now - STALE_MS).run();
  const open = await db.prepare("SELECT * FROM beets_runs WHERE family_id = ? AND kind = 'youtube' AND status IN ('requested','running')")
    .bind(familyId).all<RunRow>();
  const same = open.results.find((r) => parsePayload(r.payload)?.url === p.url);
  if (same) return { run: toRun(same), created: false };
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO beets_runs (id, family_id, kind, status, requested_by, requested_at, payload) VALUES (?, ?, 'youtube', 'requested', ?, ?, ?)")
      .bind(id, familyId, uid, now, JSON.stringify(p)),
    pruneRuns(db, familyId, "youtube"),
  ]);
  return { run: (await getRun(db, id))!, created: true };
}

/** The oldest queued YouTube link, if any. */
export async function nextQueuedYoutube(db: D1Database): Promise<{ run: BeetsRun; payload: YoutubePayload } | null> {
  const r = await db.prepare("SELECT * FROM beets_runs WHERE kind = 'youtube' AND status = 'requested' ORDER BY requested_at ASC LIMIT 1").first<RunRow>();
  const payload = r ? parsePayload(r.payload) : null;
  if (r && !payload) {
    await failRun(db, r.id, "The queued link could not be read.");
    return nextQueuedYoutube(db);
  }
  return r && payload ? { run: toRun(r), payload } : null;
}

export async function runningYoutubeCount(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM beets_runs WHERE kind = 'youtube' AND status = 'running'").first<{ n: number }>();
  return r?.n ?? 0;
}

/** Takes a queued run for dispatch: only one caller wins. */
export async function claimRun(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("UPDATE beets_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'requested'").bind(Date.now(), id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Gives a claimed run back to the queue (the server had no free slot, or could not be reached). */
export async function requeueRun(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE beets_runs SET status = 'requested', started_at = NULL WHERE id = ? AND status = 'running'").bind(id).run();
}

/** True when the server's list of running jobs lacks a run the database thinks is running (and it is not just starting). */
export function goneFromServer(run: Pick<BeetsRun, "id" | "status" | "startedAt" | "requestedAt">, jobs: { id: string }[], now = Date.now()): boolean {
  return run.status === "running" && !jobs.some((j) => j.id === run.id) && now - (run.startedAt ?? run.requestedAt) > START_GRACE_MS;
}

/**
 * The home server just started: whatever it was running died with it. Closes those runs so queued links go on.
 * The nightly enrich script is a separate process on the host and keeps its record.
 */
export async function resetRunning(db: D1Database): Promise<void> {
  await db.prepare(
    "UPDATE beets_runs SET status = 'failed', finished_at = ?, log = 'The server restarted while this was running.' " +
      "WHERE status = 'running' AND (kind IN ('import','youtube') OR requested_by != 'agent')",
  ).bind(Date.now()).run();
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
