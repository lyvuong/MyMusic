"""Enrich: Vietnamese tag fixes, cover art, embedded art and genres."""
import os
import subprocess
import time

import config
from locks import beets_lock
from reporting import report, worker_post
from util import append_file


def run_enrich(run_id, payload=None):
    """Vietnamese tag fixes, cover art, art embedded in the files, and genres for albums that still lack them
    (same steps as beets-enrich.sh)."""
    lines = []
    exit_code = 0
    try:
        with beets_lock(7200):
            lines.append("=== %s enrich start (manual) ===\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            # fix-vietnamese.py is piped into the container's Python on stdin (it lives next to enrich.log).
            fix_script = os.path.join(config.APPDATA, "fix-vietnamese.py")
            steps = [(["beet", "fetchart"], None), (["beet", "embedart", "-y", "added:-14d.."], None), (["beet", "lastgenre"], None)]
            if os.path.exists(fix_script):
                steps.insert(0, (["/lsiopy/bin/python3", "-", "--apply"], fix_script))
            else:
                lines.append("fix-vietnamese.py not found in %s: skipping the Vietnamese tag fix\n" % config.APPDATA)
            for i, (cmd, stdin_path) in enumerate(steps):
                # Progress for the app: before = number of steps, now = steps still to do (the app shows "step k of n").
                worker_post("/api/beets/agent/progress", {"id": run_id, "before": len(steps), "now": len(steps) - i})
                if stdin_path:
                    with open(stdin_path, "rb") as script:
                        r = subprocess.run(config.DOCKER + ["exec", "-i", config.BEETS] + cmd, stdin=script, capture_output=True, text=True,
                                           encoding="utf-8", errors="replace")
                else:
                    r = subprocess.run(config.DOCKER + ["exec", config.BEETS] + cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
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
