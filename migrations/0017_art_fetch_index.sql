-- "Find covers" asks for the next songs without a cover, and how many are left, once per 10 songs. Without this index
-- every one of those calls read the family's whole song list.
CREATE INDEX tracks_family_art_tried ON tracks (family_id, source, art_tried);
