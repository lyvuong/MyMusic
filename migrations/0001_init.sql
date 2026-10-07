CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('r2','nas')),
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  track_no INTEGER NOT NULL DEFAULT 0,
  art_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  etag TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, source_key)
);
CREATE INDEX tracks_updated ON tracks (updated_at);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX playlists_updated ON playlists (owner, updated_at);

CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, pos)
);
