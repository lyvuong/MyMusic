-- Nightly AI mixes, one per member and day-part (morning | afternoon | evening | night), built by the cron trigger.
CREATE TABLE daily_mixes (
  uid TEXT NOT NULL,
  family_id TEXT NOT NULL REFERENCES families(id),
  daypart TEXT NOT NULL,
  title TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  track_ids TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, daypart)
);
