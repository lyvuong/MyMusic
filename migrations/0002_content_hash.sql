-- SHA-256 of the uploaded file, used to skip exact duplicate uploads. NULL for tracks uploaded before this migration.
ALTER TABLE tracks ADD COLUMN content_hash TEXT;
CREATE INDEX tracks_family_hash ON tracks (family_id, content_hash);
