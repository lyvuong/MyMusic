-- Songs a member moved on from within the first minute. Kept apart from `plays` on purpose: plays feed the family's
-- popular list, skips only shape that member's own nightly mixes.
CREATE TABLE skips (
  uid TEXT NOT NULL,
  track_id TEXT NOT NULL,
  family_id TEXT NOT NULL REFERENCES families(id),
  skipped_at INTEGER NOT NULL,
  PRIMARY KEY (uid, track_id, skipped_at)
);
