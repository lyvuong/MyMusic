-- Where songs added from YouTube came from, so "Review AI songs" can ask YouTube again whether a video is labelled as made
-- with AI. Matched to the library by title + artist (like pending_ai). Kept for good; filled when a link is queued.
CREATE TABLE youtube_sources (
  family_id  TEXT NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, url)
);
CREATE INDEX youtube_sources_song ON youtube_sources (family_id, title, artist);

-- Links imported before this table existed: the recent ones are still in the run history.
INSERT OR IGNORE INTO youtube_sources (family_id, url, title, artist, created_at)
SELECT family_id, json_extract(payload, '$.url'), json_extract(payload, '$.title'), json_extract(payload, '$.artist'), requested_at
FROM beets_runs
WHERE kind = 'youtube' AND status = 'done' AND payload IS NOT NULL
  AND json_extract(payload, '$.url') IS NOT NULL AND json_extract(payload, '$.title') IS NOT NULL AND json_extract(payload, '$.artist') IS NOT NULL;
