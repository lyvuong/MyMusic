#!/bin/bash
# Unraid "User Scripts" job, schedule: custom cron `0 3 * * *` (every night at 3:00).
#
# Second half of the two-run setup: the web app's Organize button (beets-agent.sh) imports with only the
# `musicbrainz scrub` plugins so it finishes fast. This job adds what that run skipped, for albums already in the
# library: cover art, art embedded in the files, and genres. It uses the full plugin list from config.yaml.
# Each step only touches albums that still lack the data, so a night with nothing new ends in seconds.

LOG="/mnt/user/appdata/beets/enrich.log"

# Never overlap with an import (the Organize button or anything else holding this lock); wait up to 2 hours.
echo "=== $(date '+%Y-%m-%d %H:%M:%S') waiting for the import lock ===" >> "$LOG"
exec 9>/tmp/beets-import.lock
if ! flock -w 7200 9; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') gave up: an import held the lock for 2 hours ===" >> "$LOG"
  exit 1
fi

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') enrich start ==="
  docker exec beets beet fetchart                      # skips albums that already have art
  docker exec beets beet embedart -y 'added:-14d..'    # writes the cover into files; recent albums only (rewrites files)
  docker exec beets beet lastgenre                     # skips albums that already have a genre
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') enrich done ==="
} >> "$LOG" 2>&1
