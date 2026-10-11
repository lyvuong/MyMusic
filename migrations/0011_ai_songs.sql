-- Songs made by AI get a badge in the app. Set by hand (Edit details) or when adding a song from YouTube.
ALTER TABLE tracks ADD COLUMN ai INTEGER NOT NULL DEFAULT 0;

-- A song added from YouTube as AI-generated: it only reaches the library after the next NAS sync, so the flag waits here
-- and is applied (matching title + artist) by the sync. Rows are dropped once applied or after a few days.
CREATE TABLE pending_ai (
  family_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
