"""Enrich: Vietnamese tag fixes, cover art, embedded art and genres.

It works through the library in small chunks and takes the library lock for one chunk at a time, stepping aside when an
import or a YouTube song is waiting, so a long enrich never keeps new songs out of the library.
"""
import os
import subprocess
import time

import config
from locks import beets_lock
from reporting import report, worker_post
from util import append_file

CHUNK = 100  # albums per beet call


def id_ranges(ids, size=CHUNK):
    """(first id, last id) of consecutive groups of `size` album ids, for queries like `id:10..250`."""
    ids = sorted(ids)
    return [(ids[i], ids[min(i + size, len(ids)) - 1]) for i in range(0, len(ids), size)]


def album_ids():
    """Ids of every album in the library, or None when they cannot be listed (then the whole library is one call)."""
    try:
        r = subprocess.run(config.DOCKER + ["exec", config.BEETS, "beet", "ls", "-a", "-f", "$id"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=300)
    except (subprocess.SubprocessError, OSError):
        return None
    if r.returncode:
        return None
    return [int(x) for x in r.stdout.split() if x.isdigit()]


def chunked(cmd, ids):
    """`cmd` once per group of albums (a query on the album id is appended), or once for everything without ids."""
    if ids is None:
        return [cmd]
    return [cmd + ["id:%d..%d" % r] for r in id_ranges(ids)]


def run_enrich(run_id, payload=None):
    """Vietnamese tag fixes, cover art, art embedded in the files, and genres for albums that still lack them
    (same steps as beets-enrich.sh)."""
    lines = []
    exit_code = 0
    try:
        lines.append("=== %s enrich start (manual) ===\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
        ids = album_ids()
        # Each step is a list of (command, file piped to its stdin). fix-vietnamese.py is piped into the container's
        # Python on stdin (it lives next to enrich.log).
        fix_script = os.path.join(config.APPDATA, "fix-vietnamese.py")
        steps = []
        if os.path.exists(fix_script):
            steps.append([(["/lsiopy/bin/python3", "-", "--apply"], fix_script)])
        else:
            lines.append("fix-vietnamese.py not found in %s: skipping the Vietnamese tag fix\n" % config.APPDATA)
        steps.append([(c, None) for c in chunked(["beet", "fetchart"], ids)])
        steps.append([(["beet", "embedart", "-y", "added:-14d.."], None)])
        steps.append([(c, None) for c in chunked(["beet", "lastgenre"], ids)])
        for i, step in enumerate(steps):
            # Progress for the app: before = number of steps, now = steps still to do (the app shows "step k of n").
            worker_post("/api/beets/agent/progress", {"id": run_id, "before": len(steps), "now": len(steps) - i})
            for cmd, stdin_path in step:
                with beets_lock(7200, polite=True):
                    if stdin_path:
                        with open(stdin_path, "rb") as script:
                            r = subprocess.run(config.DOCKER + ["exec", "-i", config.BEETS] + cmd, stdin=script, capture_output=True,
                                               text=True, encoding="utf-8", errors="replace")
                    else:
                        r = subprocess.run(config.DOCKER + ["exec", config.BEETS] + cmd, capture_output=True, text=True,
                                           encoding="utf-8", errors="replace")
                lines.append(r.stdout + r.stderr)
                if r.returncode:
                    exit_code = r.returncode
        lines.append("=== %s enrich done (exit %d) ===\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), exit_code))
    except TimeoutError as e:
        lines.append("Gave up: %s\n" % e)
        exit_code = 1
    except Exception as e:
        lines.append("Enrich failed: %s\n" % e)
        exit_code = 1
    text = "".join(lines)
    append_file(os.path.join(config.APPDATA, "enrich.log"), text)
    report(run_id, exit_code == 0, exit_code, text)
