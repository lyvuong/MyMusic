-- A genre for the artists whose songs have none, so the genre mixes can use them. Kept apart from `tracks` (a library
-- sync never touches it, and the tags a song really has are never overwritten): the mixes use the song's own genre
-- and fall back to its artist's.
--  * source 'tags': the artist's most common genre among their tagged songs.
--  * source 'ai': judged by the AI from the artist's name and a few titles; genre '' = it did not know, and is not asked again.
CREATE TABLE artist_genres (
  family_id TEXT NOT NULL REFERENCES families(id),
  artist TEXT NOT NULL,
  genre TEXT NOT NULL,
  source TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, artist)
);
