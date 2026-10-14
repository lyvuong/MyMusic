-- Album suggestions for songs that have none, found by the missing-album finder (online catalogues and audio fingerprint).
-- One row per song, kept apart from `tracks` so a library sync never touches them.
--  * status 'open': guesses (JSON, most confident first) wait for the owner to confirm.
--  * status 'none': nothing was found; not looked up again until the owner asks.
--  * status 'dismissed': the owner chose "none of these"; not looked up again.
-- A song that got an album (by hand or by auto-apply) has its row deleted.
CREATE TABLE album_suggestions (
  family_id TEXT NOT NULL REFERENCES families(id),
  track_id TEXT NOT NULL,
  guesses TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, track_id)
);
CREATE INDEX album_suggestions_status ON album_suggestions (family_id, status);

-- Per family: whether the nightly run may write an album by itself (only when two catalogues agree at 95% or more).
CREATE TABLE album_settings (
  family_id TEXT PRIMARY KEY REFERENCES families(id),
  auto_apply INTEGER NOT NULL DEFAULT 0
);
