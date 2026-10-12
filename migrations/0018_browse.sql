-- Browsing by search, genre and "recently added" without reading the whole library.
--  * genre: filled by the NAS sync.
--  * tracks_fts: a full-text index over title, artist, album and genre (accents ignored; d with stroke is written as d
--    because the tokenizer does not decompose it). The triggers keep it in step with the tracks table.
--  * family_cache: lists that are expensive to build and fine to be a few hours old (genres, most played).
--  * members.last_seen_at: the nightly mixes are not rebuilt for somebody who has not opened the app since the last one.
ALTER TABLE tracks ADD COLUMN genre TEXT NOT NULL DEFAULT '';
CREATE INDEX tracks_family_genre ON tracks (family_id, genre, deleted);
-- "Recently added" walks the songs newest first (by rowid) and stops after a page; this keeps that from reading them all.
CREATE INDEX tracks_family_live ON tracks (family_id, deleted);
-- The artist and album indexes of 0016 gain `deleted`: every query that uses them filters on it, and without it SQLite
-- prefers the index above (same two columns it can match) and reads the whole family again.
DROP INDEX tracks_family_artist;
DROP INDEX tracks_family_album;
CREATE INDEX tracks_family_artist ON tracks (family_id, artist, deleted);
CREATE INDEX tracks_family_album ON tracks (family_id, album, deleted);

ALTER TABLE members ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE family_cache (
  family_id TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, key)
);

CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist, album, genre, tokenize = 'unicode61 remove_diacritics 2');

INSERT INTO tracks_fts (rowid, title, artist, album, genre)
SELECT rowid, replace(replace(title, 'đ', 'd'), 'Đ', 'D'), replace(replace(artist, 'đ', 'd'), 'Đ', 'D'),
       replace(replace(album, 'đ', 'd'), 'Đ', 'D'), replace(replace(genre, 'đ', 'd'), 'Đ', 'D')
FROM tracks;

CREATE TRIGGER tracks_fts_insert AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts (rowid, title, artist, album, genre)
  VALUES (new.rowid, replace(replace(new.title, 'đ', 'd'), 'Đ', 'D'), replace(replace(new.artist, 'đ', 'd'), 'Đ', 'D'),
          replace(replace(new.album, 'đ', 'd'), 'Đ', 'D'), replace(replace(new.genre, 'đ', 'd'), 'Đ', 'D'));
END;

CREATE TRIGGER tracks_fts_update AFTER UPDATE OF title, artist, album, genre ON tracks
WHEN old.title IS NOT new.title OR old.artist IS NOT new.artist OR old.album IS NOT new.album OR old.genre IS NOT new.genre
BEGIN
  DELETE FROM tracks_fts WHERE rowid = old.rowid;
  INSERT INTO tracks_fts (rowid, title, artist, album, genre)
  VALUES (new.rowid, replace(replace(new.title, 'đ', 'd'), 'Đ', 'D'), replace(replace(new.artist, 'đ', 'd'), 'Đ', 'D'),
          replace(replace(new.album, 'đ', 'd'), 'Đ', 'D'), replace(replace(new.genre, 'đ', 'd'), 'Đ', 'D'));
END;

CREATE TRIGGER tracks_fts_delete AFTER DELETE ON tracks BEGIN
  DELETE FROM tracks_fts WHERE rowid = old.rowid;
END;
