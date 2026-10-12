#!/bin/bash
# Unraid "User Scripts" job, schedule: custom cron `0 3 * * *` (every night at 3:00).
#
# Second half of the two-run setup: the web app's Organize button (scripts/unraid/mymusic-api) imports with only the
# `musicbrainz scrub` plugins so it finishes fast. This job adds what that run skipped, for albums already in the
# library: Vietnamese tag fixes (decoding and capitalising words, scripts/unraid/fix-vietnamese.py), cover art, art
# embedded in the files, and genres. It uses the full plugin list from config.yaml.
# Each step only touches albums that still lack the data, so a night with nothing new ends in seconds.
#
# Each night is also reported to the MyMusic Worker, so the Library tools tab shows it under "History of imports and jobs". It uses the
# same key file as the mymusic-api container; if the Worker cannot be reached the job still runs and only logs locally.

LOG="/mnt/user/appdata/beets/enrich.log"
API="https://mymusic.lv5.uk"                       # the Worker (same address as WORKER_URL of mymusic-api)
LOCAL_API="http://localhost:8099"                  # mymusic-api on this server
KEY_FILE="/boot/config/mymusic-agent.key"
FIXVN="/mnt/user/appdata/beets/fix-vietnamese.py"   # copy of scripts/unraid/fix-vietnamese.py
KEY=$(tr -d '[:space:]' < "$KEY_FILE" 2>/dev/null)

# Tell the web app this night has begun (it may still wait for the import lock below).
ID=""
[ -n "$KEY" ] && ID=$(curl -fsS --max-time 20 -X POST -H "X-Agent-Key: $KEY" "$API/api/beets/agent/enrich-start" 2>/dev/null)

# Sends the result (the last 6000 characters of the log file) to the web app.
report() { # report <ok 1|0> <exit code> <log file>
  [ -n "$ID" ] || return 0
  for try in 1 2 3; do
    tail -c 6000 "$3" | curl -fsS --max-time 30 -X POST -H "X-Agent-Key: $KEY" -H "Content-Type: text/plain" \
      --data-binary @- "$API/api/beets/agent/report?id=$ID&ok=$1&exit=$2" > /dev/null 2>&1 && break
    sleep 10
  done
}

RUNLOG=$(mktemp)

# Preferred route: hand the run to mymusic-api. It does the same steps in small chunks, so an import that arrives
# meanwhile is not kept waiting, and it reports the result itself. Only when it cannot be reached does this script
# do the work below (same steps, one long lock).
if [ -n "$ID" ] && [ -n "$KEY" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H "X-Agent-Key: $KEY" -H "Content-Type: application/json"     -d "{\"kind\":\"enrich\",\"id\":\"$ID\"}" "$LOCAL_API/jobs")
  if [ "$CODE" = "202" ]; then
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') enrich handed to mymusic-api ===" >> "$LOG"
    rm -f "$RUNLOG"
    exit 0
  fi
  if [ "$CODE" = "409" ]; then   # an enrich is already running (the automatic one): that one covers this night
    MSG="=== $(date '+%Y-%m-%d %H:%M:%S') skipped: an enrich was already running ==="
    echo "$MSG" >> "$LOG"
    echo "$MSG" > "$RUNLOG"
    report 1 0 "$RUNLOG"
    rm -f "$RUNLOG"
    exit 0
  fi
fi

# Never overlap with an import (the Organize button or anything else holding this lock); wait up to 2 hours.
echo "=== $(date '+%Y-%m-%d %H:%M:%S') waiting for the import lock ===" >> "$LOG"
exec 9>/tmp/beets-import.lock
if ! flock -w 7200 9; then
  MSG="=== $(date '+%Y-%m-%d %H:%M:%S') gave up: an import held the lock for 2 hours ==="
  echo "$MSG" >> "$LOG"
  echo "$MSG" > "$RUNLOG"
  report 0 1 "$RUNLOG"
  rm -f "$RUNLOG"
  exit 1
fi

E=0
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') enrich start ==="
  if [ -f "$FIXVN" ]; then
    docker exec -i beets /lsiopy/bin/python3 - --apply < "$FIXVN" || E=$?   # decodes ASCII-typed Vietnamese, capitalises words
  else
    echo "fix-vietnamese.py not found at $FIXVN: skipping the Vietnamese tag fix"
  fi
  docker exec beets beet fetchart || E=$?                      # skips albums that already have art
  docker exec beets beet embedart -y 'added:-14d..' || E=$?    # writes the cover into files; recent albums only (rewrites files)
  docker exec beets beet lastgenre || E=$?                     # skips albums that already have a genre
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') enrich done (exit $E) ==="
} > "$RUNLOG" 2>&1
cat "$RUNLOG" >> "$LOG"

OK=0; [ "$E" -eq 0 ] && OK=1
report "$OK" "$E" "$RUNLOG"
rm -f "$RUNLOG"
