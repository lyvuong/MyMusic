-- YouTube links wait in the same table until a download slot is free on the home server: the details of a queued
-- link (url, title, artist, album) are kept here as JSON until it is dispatched.
ALTER TABLE beets_runs ADD COLUMN payload TEXT;
