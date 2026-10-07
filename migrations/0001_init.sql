CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- v1: a user belongs to at most one family (PRIMARY KEY on uid).
CREATE TABLE members (
  uid TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at INTEGER NOT NULL
);
CREATE INDEX members_family ON members (family_id);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
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
  UNIQUE (family_id, source, source_key)
);
CREATE INDEX tracks_family_updated ON tracks (family_id, updated_at);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  owner_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX playlists_family_updated ON playlists (family_id, updated_at);

CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, pos)
);
