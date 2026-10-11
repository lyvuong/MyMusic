-- One row per song played, so the family's popular songs can feed the AI mixes and the car's "Popular" list.
CREATE TABLE plays (
  uid TEXT NOT NULL,
  track_id TEXT NOT NULL,
  family_id TEXT NOT NULL REFERENCES families(id),
  played_at INTEGER NOT NULL,
  PRIMARY KEY (uid, track_id, played_at)
);
CREATE INDEX plays_family ON plays (family_id, played_at);
