-- Renaming an artist or an album looks songs up by that name. Without these, every rename read every song in the family
-- (several times), which is what ate the daily D1 rows_read allowance when a whole clean-up was applied.
CREATE INDEX tracks_family_artist ON tracks (family_id, artist);
CREATE INDEX tracks_family_album ON tracks (family_id, album);
