-- Beets import runs on the home server. The web app requests a run; a script on the server polls for it,
-- runs `beet import` and reports the result (see scripts/unraid/beets-agent.sh).
CREATE TABLE beets_runs (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  status TEXT NOT NULL CHECK (status IN ('requested','running','done','failed')),
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  inbox_before INTEGER,
  inbox_after INTEGER,
  exit_code INTEGER,
  log TEXT NOT NULL DEFAULT ''
);
CREATE INDEX beets_runs_family ON beets_runs (family_id, requested_at);
