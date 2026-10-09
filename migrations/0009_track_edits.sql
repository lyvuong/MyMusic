-- Songs whose title, artist, album or track number were edited in the web app. The NAS sync leaves those four
-- fields alone for such songs (otherwise the next sync would restore the names from the files' tags).
ALTER TABLE tracks ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
