-- How widely known each song is, judged once by the AI from its artist and title (0 unknown/obscure, 1 moderately known,
-- 2 well known, 3 a major hit). Kept apart from `tracks` so a library sync never touches it.
CREATE TABLE song_fame (
  track_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 3),
  judged_at INTEGER NOT NULL
);
CREATE INDEX song_fame_family ON song_fame (family_id, score);
