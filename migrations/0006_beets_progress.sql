-- Live progress of a Beets run: files still in the inbox, reported by the server script while the import runs.
ALTER TABLE beets_runs ADD COLUMN inbox_now INTEGER;
