#!/usr/bin/env python3
"""MyMusic home API: runs on the Unraid server next to Beets and does the work the web app asks for.

The Worker (Cloudflare) calls this through a Cloudflare Tunnel; nothing here polls. Every request needs the shared key
in the X-Agent-Key header. Endpoints (fixed; no paths or commands ever come from a request):

  GET  /health   -> {"ok": true, "busy": null | "import" | "enrich" | "youtube", "jobs": [{kind, id}], "waiting": files in the inbox}
                 checks that the beets container answers
  POST /edit     {"ops": [...]}  writes edited names into the files and the Beets library, waits for the result
  POST /cover    {"album": "...", "image": "<base64 jpeg>"}  writes cover.jpg into the folders of that album (embeds it when a folder is shared)
  POST /jobs     {"id": "...", "kind": "import" | "enrich"}  starts a long job and returns at once (202); progress and the
                 result are posted to the Worker (/api/beets/agent/progress and /report) under that run id
  POST /yt-info  {"url": "https://youtu.be/..."}  looks a YouTube video up (title, artist, duration) without downloading it
  POST /jobs     {"id": "...", "kind": "youtube", "url": "...", "title": "...", "artist": "...", "album": ""}  downloads the
                 audio with yt-dlp (in the yt-dlp container), tags it as given and imports it into Beets as it is

Needs: the docker CLI and /var/run/docker.sock (it runs `docker exec beets ...`), the inbox folder (read only, to count
files) and the host's /tmp (to share /tmp/beets-import.lock with beets-enrich.sh). See "Beets runs from the web app"
in the README for the compose entry.

The code is split by job: config (settings), locks (library lock + one job at a time), reporting (back to the Worker),
jobs/ (import, enrich, youtube), watcher (imports by itself when files arrive), mixes (asks the Worker for the
nightly AI mixes), albums (asks it to look for missing albums), edit (name and cover edits),
http_handler (routing). Copy the whole folder to the server.
"""
import os
import threading
from http.server import ThreadingHTTPServer

import config
import albums
import mixes
import reporting
import watcher
from http_handler import Handler
from jobs.importer import count_inbox, recover_staging
from jobs.youtube import clear_leftovers
from util import log


def main():
    log("mymusic-api listening on :%d (worker %s, container %s)" % (config.PORT, config.WORKER, config.BEETS))
    if not os.path.isdir(config.INBOX):
        log("WARNING: %s does not exist; mount the inbox (see README) or the progress bar will stay empty" % config.INBOX)
    else:
        log("inbox %s holds %d file(s)" % (config.INBOX, count_inbox()))
    recover_staging()
    clear_leftovers()
    # Runs the Worker still lists as running died with the previous process: close them so queued YouTube links go on.
    threading.Thread(target=reporting.worker_post, args=("/api/beets/agent/reset",), kwargs={"tries": 3}, daemon=True).start()
    watcher.start()
    mixes.start()
    albums.start()
    ThreadingHTTPServer(("0.0.0.0", config.PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
