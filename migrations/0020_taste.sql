-- Each member's taste profile (top artists and songs, from their own ratings, plays and skips), rebuilt with the
-- nightly mixes. The mixes' AI prompt uses it and the family page shows it.
CREATE TABLE taste_profiles (
  uid TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  artists TEXT NOT NULL,
  tracks TEXT NOT NULL,
  built_at INTEGER NOT NULL
);
CREATE INDEX taste_profiles_family ON taste_profiles (family_id);
