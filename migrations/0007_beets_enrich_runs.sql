-- The nightly enrich job (scripts/unraid/beets-enrich.sh) reports its runs into the same table as the web app's imports.
ALTER TABLE beets_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'import';
