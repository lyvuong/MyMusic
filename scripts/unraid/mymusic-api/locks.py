"""Never run two things against the Beets library at once, and never run two long jobs at once."""
import threading
import time
from contextlib import contextmanager

import config
from reporting import report
from util import log


@contextmanager
def beets_lock(wait):
    """Holds /tmp/beets-import.lock (shared with beets-enrich.sh) or raises TimeoutError after `wait` seconds."""
    import fcntl  # Unix only; imported here so the rest of the module (and the tests) load anywhere
    f = open(config.LOCK_PATH, "w")
    deadline = time.time() + wait
    try:
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() >= deadline:
                    raise TimeoutError("the Beets library is busy (an import or enrich is running)")
                time.sleep(1)
        yield
    finally:
        f.close()


current = None  # {"kind", "id"} of the job running now
guard = threading.Lock()


def busy_kind():
    return current["kind"] if current else None


def start_job(kind, run_id, payload=None):
    """Starts a job in a thread. Returns (True, "") or (False, why) when another job is running."""
    global current
    from jobs import JOBS  # imported here: the job modules import this one
    with guard:
        if current:
            return False, "Another job (%s) is already running on the server." % current["kind"]
        current = {"kind": kind, "id": run_id}

    def work():
        global current
        try:
            JOBS[kind](run_id, payload)
        except Exception as e:
            log("job %s crashed: %s" % (run_id, e))
            report(run_id, False, 1, "The job crashed: %s" % e)
        finally:
            with guard:
                current = None

    threading.Thread(target=work, daemon=True).start()
    return True, ""
