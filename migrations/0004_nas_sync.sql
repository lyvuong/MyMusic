-- Id of the NAS sync run that last saw this track; tracks a run did not see were removed from the NAS.
ALTER TABLE tracks ADD COLUMN sync_seen INTEGER;
