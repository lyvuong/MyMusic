"""The Organize button: import what is in the inbox into the Beets library."""
import os
import subprocess
import tempfile

import config
from locks import beets_lock
from reporting import report, worker_post
from util import append_file, log


def count_inbox():
    return sum(len(files) for _, _, files in os.walk(config.INBOX))


def run_import(run_id, payload=None):
    """The Organize button: pass 1 groups files into albums by their tags, pass 2 imports leftovers one by one.
    Only musicbrainz, scrub and fromfilename load, so it is fast; enrich adds art and genres."""
    before = count_inbox()
    log("import %s: %d file(s) in %s" % (run_id, before, config.INBOX))
    if not worker_post("/api/beets/agent/progress", {"id": run_id, "before": before, "now": before}):
        log("import %s: the Worker did not accept progress; the web app will show no progress bar" % run_id)
    out = tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False)
    exit_code = 0
    try:
        with beets_lock(3600):
            for i, flag in enumerate(("-g", "-s")):
                if i == 1:
                    out.write("--- second pass: leftovers as single tracks ---\n")
                    out.flush()
                proc = subprocess.Popen(
                    config.DOCKER + ["exec", config.BEETS, "beet", "-p", "musicbrainz,scrub,fromfilename", "import", flag, "-q", "/downloads"],
                    stdout=out, stderr=subprocess.STDOUT,
                )
                while True:
                    try:
                        proc.wait(timeout=10)
                        break
                    except subprocess.TimeoutExpired:
                        worker_post("/api/beets/agent/progress", {"id": run_id, "before": before, "now": count_inbox()})
                if proc.returncode:
                    exit_code = proc.returncode
    except TimeoutError as e:
        out.write("Gave up: %s\n" % e)
        exit_code = 1
    except Exception as e:  # keep the report path alive whatever happens
        out.write("Import failed: %s\n" % e)
        exit_code = 1
    finally:
        out.flush()
        out.seek(0)
        text = out.read()
        out.close()
        os.unlink(out.name)
    append_file(os.path.join(config.APPDATA, "auto-import.log"), text)
    report(run_id, exit_code == 0, exit_code, text or "(no output: nothing to import)", before, count_inbox())
