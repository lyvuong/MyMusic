"""Talking back to the Worker: progress while a job runs, and the final report."""
import time
import urllib.error
import urllib.parse
import urllib.request

import config
from util import log


def worker_post(path, query=None, body=None, tries=1):
    url = config.WORKER + path + ("?" + urllib.parse.urlencode(query) if query else "")
    for attempt in range(tries):
        req = urllib.request.Request(url, data=body if body is not None else b"", method="POST")
        req.add_header("X-Agent-Key", config.KEY)
        # urllib's default "Python-urllib" signature is blocked by Cloudflare's browser check (403, error 1010).
        req.add_header("User-Agent", "mymusic-api/1.0 (+home server)")
        if body is not None:
            req.add_header("Content-Type", "text/plain; charset=utf-8")
        try:
            with urllib.request.urlopen(req, timeout=30):
                return True
        except (urllib.error.URLError, OSError) as e:
            log("worker %s failed: %s" % (path, e))
            if attempt + 1 < tries:
                time.sleep(10)
    return False


def report(run_id, ok, exit_code, logtext, before=None, after=None):
    q = {"id": run_id, "ok": "1" if ok else "0", "exit": str(exit_code)}
    if before is not None:
        q["before"] = str(before)
    if after is not None:
        q["after"] = str(after)
    worker_post("/api/beets/agent/report", q, (logtext[-6000:] or "(no output)").encode("utf-8"), tries=3)
