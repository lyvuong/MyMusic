"""Asks the Worker to look for the albums of songs that have none, once a night.

Same clock as mixes.py: at ALBUMS_HOUR (container time) it calls /api/beets/agent/albums, five songs per request, until
nothing is left or ALBUMS_MAX songs were looked at (so a big backlog is spread over several nights). The Worker only
saves suggestions for the owner to confirm, unless the owner switched on auto-apply in Library tools.
"""
import threading
import time

import config
import reporting
from mixes import seconds_until
from util import log


def run_once(post=reporting.worker_json, cap=None):
    """Looks at songs until none are left or `cap` were checked. Returns the totals, or None if the Worker was unreachable
    before anything was done."""
    cap = config.ALBUMS_MAX if cap is None else cap
    total = {"checked": 0, "saved": 0, "applied": 0}
    while total["checked"] < cap:
        r = post("/api/beets/agent/albums", {"limit": "5"}, timeout=170)
        if r is None:
            return total if total["checked"] else None
        n = int(r.get("checked", 0))
        for k in total:
            total[k] += int(r.get(k, 0))
        if n == 0 or int(r.get("remaining", 0)) == 0:
            break
    return total


def loop(sleep=time.sleep, run=run_once):
    while True:
        sleep(seconds_until(config.ALBUMS_HOUR))
        for attempt in range(3):
            r = run()
            if r is not None:
                log("nightly albums: %(checked)d checked, %(saved)d suggested, %(applied)d applied" % r)
                break
            sleep(600)  # the Worker or the network was down: try again in 10 minutes


def start():
    """Starts the nightly thread unless ALBUMS_HOUR is -1."""
    if not 0 <= config.ALBUMS_HOUR <= 23:
        log("nightly albums: off (ALBUMS_HOUR=%d)" % config.ALBUMS_HOUR)
        return None
    wait = seconds_until(config.ALBUMS_HOUR)
    log("nightly albums: next run at %02d:00 container time (in %dh%02dm), up to %d songs" % (config.ALBUMS_HOUR, wait // 3600, wait % 3600 // 60, config.ALBUMS_MAX))
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t
