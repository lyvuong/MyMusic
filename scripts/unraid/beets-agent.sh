#!/bin/bash
# Unraid "User Scripts" job, schedule: custom cron `* * * * *` (every minute).
#
# Asks the MyMusic Worker whether the family owner clicked "Organize inbox and update library" in the web app.
# If so, runs Beets on the inbox and reports the result back. Only outgoing HTTPS requests are made, so nothing
# on the server is exposed. Setup: see "Beets runs from the web app" in the README.
#
# Needs: the Worker secret BEETS_AGENT_KEY, saved on the server in /boot/config/mymusic-agent.key (one line).

API="https://mymusic.lyvuong.workers.dev"
KEY_FILE="/boot/config/mymusic-agent.key"
INBOX="/mnt/user/Music/_inbox"          # the same folder Beets sees as /downloads
IMPORT_LOG="/mnt/user/appdata/beets/auto-import.log"

KEY=$(tr -d '[:space:]' < "$KEY_FILE") || exit 1
[ -n "$KEY" ] || exit 1

# One agent at a time: a long import must not start a second one on the next minute.
exec 9>/tmp/mymusic-agent.lock
flock -n 9 || exit 0

ID=$(curl -fsS --max-time 20 -X POST -H "X-Agent-Key: $KEY" "$API/api/beets/agent/poll") || exit 0
[ -n "$ID" ] || exit 0                   # 204: nothing requested

count() { find "$INBOX" -type f 2>/dev/null | wc -l; }

LOG=$(mktemp)
BEFORE=$(count)
# Wait (up to an hour) if the scheduled import is running, so two imports never overlap.
flock -w 3600 /tmp/beets-import.lock docker exec beets beet import -g -q /downloads > "$LOG" 2>&1
EXIT=$?
AFTER=$(count)
cat "$LOG" >> "$IMPORT_LOG"

OK=0; [ "$EXIT" -eq 0 ] && OK=1
[ -s "$LOG" ] || echo "(no output: nothing to import)" > "$LOG"

for try in 1 2 3; do
  tail -c 6000 "$LOG" | curl -fsS --max-time 30 -X POST -H "X-Agent-Key: $KEY" -H "Content-Type: text/plain" \
    --data-binary @- "$API/api/beets/agent/report?id=$ID&ok=$OK&before=$BEFORE&after=$AFTER&exit=$EXIT" && break
  sleep 10
done
rm -f "$LOG"
