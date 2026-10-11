"""The Beets library lock, and which jobs may run at the same time.

One import, one enrich and up to MAX_YT YouTube jobs may run at the same time. They share the library through the
lock, which each takes only for the part that writes: an import for its whole run, a YouTube job for its last step, an
enrich for one small chunk at a time, stepping aside whenever somebody else is waiting (see `polite`).
"""
import threading
import time
import uuid
from contextlib import contextmanager

import config
from reporting import report
from util import log


_wait_lock = threading.Lock()
_waiting = 0  # callers that are queued for the library lock right now (not counting polite ones)


def library_wanted():
    """True while an import or a YouTube job is waiting for the library lock."""
    return _waiting > 0


@contextmanager
def beets_lock(wait, polite=False):
    """Holds /tmp/beets-import.lock (shared with beets-enrich.sh) or raises TimeoutError after `wait` seconds.
    A `polite` caller (the enrich) first lets everybody who is waiting go ahead, then queues for the lock itself:
    flock does not queue fairly, and a long enrich would otherwise keep winning the lock back from an import."""
    global _waiting
    import fcntl  # Unix only; imported here so the rest of the module (and the tests) load anywhere
    deadline = time.time() + wait
    counted = False
    f = None
    try:
        if polite:
            while library_wanted():
                if time.time() >= deadline:
                    raise TimeoutError("the Beets library is busy (an import is running)")
                time.sleep(1)
        else:
            with _wait_lock:
                _waiting += 1
            counted = True
        f = open(config.LOCK_PATH, "w")
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() >= deadline:
                    raise TimeoutError("the Beets library is busy (an import or enrich is running)")
                time.sleep(1)
        if counted:
            with _wait_lock:
                _waiting -= 1
            counted = False
        yield
    finally:
        if counted:
            with _wait_lock:
                _waiting -= 1
        if f is not None:
            f.close()


_cond = threading.Condition()
active = {}  # run id -> kind, for the jobs running now


def _why_blocked(kind):
    """None when a job of this kind may start now, else the reason it may not. Call with _cond held."""
    running = sum(1 for k in active.values() if k == kind)
    if kind == "youtube":
        if running >= config.MAX_YT:
            return "%d YouTube downloads are already running on the server." % config.MAX_YT
        return None
    if running:
        return "Another %s is already running on the server." % kind
    return None


def busy_kind():
    """The long job running now: import or enrich if one is, else youtube, else None."""
    with _cond:
        for k in active.values():
            if k != "youtube":
                return k
        return "youtube" if active else None


def active_jobs():
    with _cond:
        return [{"kind": k, "id": i} for i, k in active.items()]


def _run(kind, run_id, payload):
    from jobs import JOBS  # imported here: the job modules import this one
    try:
        JOBS[kind](run_id, payload)
    except Exception as e:
        log("job %s crashed: %s" % (run_id, e))
        report(run_id, False, 1, "The job crashed: %s" % e)
    finally:
        with _cond:
            active.pop(run_id, None)
            _cond.notify_all()


def start_job(kind, run_id, payload=None):
    """Starts a job in a thread. Returns (True, "") or (False, why) when it may not run now."""
    with _cond:
        why = _why_blocked(kind)
        if why:
            return False, why
        active[run_id] = kind
    threading.Thread(target=_run, args=(kind, run_id, payload), daemon=True).start()
    return True, ""


def run_job_blocking(kind, run_id=None, payload=None, make_id=None):
    """Waits until a job of this kind may run, then runs it in the calling thread (the inbox watcher uses this).
    `make_id` is called once the slot is held, so a run record is only created for a job that is really starting."""
    token = run_id or "pending-" + uuid.uuid4().hex
    with _cond:
        while _why_blocked(kind):
            _cond.wait()
        active[token] = kind
    if make_id is not None:
        try:
            new_id = make_id(kind)
        except Exception:
            with _cond:
                active.pop(token, None)
                _cond.notify_all()
            raise
        with _cond:
            active[new_id] = active.pop(token)
        token = new_id
    _run(kind, token, payload)
