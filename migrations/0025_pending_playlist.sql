-- Songs added from a YouTube playlist go into a MyMusic playlist of the same name. They only reach the library after the
-- next NAS sync, so the wish waits here and the sync (matching title + artist) adds them in order. Rows are dropped once
-- applied or after a few days.
CREATE TABLE pending_playlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id  TEXT NOT NULL,
  owner_uid  TEXT NOT NULL,
  playlist   TEXT NOT NULL,
  title      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pending_playlist_family ON pending_playlist (family_id);
