-- Set once an online cover lookup has been attempted, so misses are not retried on every run.
ALTER TABLE tracks ADD COLUMN art_tried INTEGER NOT NULL DEFAULT 0;
