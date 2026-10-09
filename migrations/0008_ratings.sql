-- Per-user song ratings (1-5 stars). A cleared rating is deleted, not stored as 0.
-- They feed the AI suggestions (worker/suggest.ts).
CREATE TABLE ratings (
  uid TEXT NOT NULL,
  track_id TEXT NOT NULL,
  family_id TEXT NOT NULL REFERENCES families(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, track_id)
);
CREATE INDEX ratings_family ON ratings (family_id);
