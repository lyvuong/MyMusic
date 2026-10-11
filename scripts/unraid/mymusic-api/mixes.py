"""Asks the Worker to build the AI mixes once a night.

Cloudflare's free plan has no spare cron triggers, so this process is the clock: at MIXES_HOUR (container time) it calls
/api/beets/agent/mixes for a few members at a time until all of them are done. The Worker skips day-parts it built less
than 20 hours ago, so a repeat after a restart costs nothing.
"""
import threading
import time

import config
import reporting
from util import log


def seconds_until(hour, now=None):
    """Seconds from `now` (a time.struct_time, default: local time) until the next time the clock shows `hour`:00."""
    now = now or time.localtime()
    since_midnight = now.tm_hour * 3600 + now.tm_min * 60 + now.tm_sec
    wait = hour * 3600 - since_midnight
    return wait if wait > 0 else wait + 86400


def run_once(post=reporting.worker_json, batch=None):
    """Builds the mixes for everyone. Returns the number of mixes saved, or None if the Worker could not be reached."""
    batch = batch or config.MIXES_BATCH
    offset = 0
    saved = 0
    while True:
        r = post("/api/beets/agent/mixes", {"offset": str(offset), "limit": str(batch)})
        if r is None:
            return None
        saved += int(r.get("mixes", 0))
        n = int(r.get("members", 0))
        if n < batch:
            return saved
        offset += n


def loop(sleep=time.sleep, run=run_once):
    while True:
        sleep(seconds_until(config.MIXES_HOUR))
        for attempt in range(3):
            saved = run()
            if saved is not None:
                log("nightly mixes: %d saved" % saved)
                break
            sleep(600)  # the Worker or the network was down: try again in 10 minutes


def start():
    """Starts the nightly thread unless MIXES_HOUR is -1."""
    if not 0 <= config.MIXES_HOUR <= 23:
        return None
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t
