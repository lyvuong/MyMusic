"""Imports what lands in the inbox by itself, driven by file events (inotify), not by polling.

`inotifywait` reports each finished write and each move into the inbox. The Inbox class remembers when every top-level
entry (a loose file, or an album folder) was last touched; an entry is taken into a batch once it has been quiet for
AUTO_IMPORT_DEBOUNCE seconds, so a folder that is still being copied is never split. Batches are imported one after
another while new files keep arriving; the enrich runs once, when nothing is waiting any more.

Needs `inotify-tools` in the container. /mnt/user is a FUSE share: events are seen for writes that go through it (SMB,
File Browser, other containers), not for writes made straight to a disk.
"""
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

import config
import reporting
from jobs.importer import inbox_entries, is_special
from locks import run_job_blocking
from util import log


class Inbox:
    """When each top-level inbox entry was last touched, and which are quiet enough to import."""

    def __init__(self, debounce, listing=inbox_entries, clock=time.monotonic):
        self.debounce = debounce
        self.listing = listing
        self.clock = clock
        self.cond = threading.Condition()
        self.last = {}      # entry -> clock time of its last event
        self.blocked = {}   # entry -> its mtime when a run failed to take it; skipped until it changes

    def touch(self, entry):
        with self.cond:
            self.last[entry] = self.clock()
            self.blocked.pop(entry, None)
            self.cond.notify_all()

    def seed(self):
        """Treats everything already in the inbox as just touched (the API may have been restarted mid-copy)."""
        for entry in self.listing():
            self.touch(entry)

    def block(self, entries, mtime_of):
        """Entries a run could not take: leave them alone until they change."""
        with self.cond:
            for e in entries:
                try:
                    self.blocked[e] = mtime_of(e)
                except OSError:
                    pass

    def _candidates(self, mtime_of):
        out = []
        for e in self.listing():
            if e in self.blocked:
                try:
                    if mtime_of(e) == self.blocked[e]:
                        continue
                except OSError:
                    continue
                del self.blocked[e]
            out.append(e)
        return out

    def waiting(self, mtime_of=lambda e: os.path.getmtime(os.path.join(config.INBOX, e))):
        with self.cond:
            return self._candidates(mtime_of)

    def next_batch(self, mtime_of=lambda e: os.path.getmtime(os.path.join(config.INBOX, e))):
        """Blocks until some entries have been quiet for the debounce time; returns them (sorted) and forgets them."""
        with self.cond:
            while True:
                now = self.clock()
                present = self._candidates(mtime_of)
                for e in list(self.last):
                    if e not in present:
                        del self.last[e]
                quiet = [e for e in present if now - self.last.get(e, float("-inf")) >= self.debounce]
                if quiet:
                    for e in quiet:
                        self.last.pop(e, None)
                    return sorted(quiet)
                known = [self.last[e] for e in present if e in self.last]
                if known:
                    self.cond.wait(timeout=max(self.debounce - (now - min(known)), 0.05))
                else:
                    self.cond.wait()  # nothing waiting: sleep until an event arrives


def entry_of(path, inbox=None):
    """The top-level inbox entry a path belongs to, or None for the server's own folders and unfinished downloads."""
    inbox = inbox or config.INBOX
    rel = os.path.relpath(path, inbox)
    first = rel.replace(os.sep, "/").split("/")[0]
    if first in ("", ".", "..") or is_special(first):
        return None
    return first


def read_events(inbox, on_entry):
    """Runs inotifywait for ever and calls on_entry(entry) for every event under the inbox."""
    cmd = ["inotifywait", "-m", "-r", "-q", "-e", "close_write", "-e", "moved_to", "-e", "create", "--format", "%w%f", config.INBOX]
    while True:
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        except FileNotFoundError:
            log("AUTO_IMPORT is on but inotifywait is not installed (apk add inotify-tools); the inbox is not watched")
            return
        log("watching %s for new files" % config.INBOX)
        for line in proc.stdout:
            entry = entry_of(line.rstrip("\n"))
            if entry:
                on_entry(entry)
        log("inotifywait stopped; restarting in 5 seconds")
        time.sleep(5)


def new_run_id(kind):
    """Asks the Worker for a run record so the batch shows up in the app; falls back to a local id when it cannot."""
    url = config.WORKER + "/api/beets/agent/%s-start" % kind
    req = urllib.request.Request(url, data=b"", method="POST")
    req.add_header("X-Agent-Key", config.KEY)
    req.add_header("User-Agent", "mymusic-api/1.0 (+home server)")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            run_id = r.read().decode("utf-8").strip()
            if config.RUN_ID_RE.match(run_id):
                return run_id
    except (urllib.error.URLError, OSError) as e:
        log("could not get a %s run id from the Worker: %s" % (kind, e))
    return "auto-" + uuid.uuid4().hex[:16]


def pipeline(inbox, run=run_job_blocking, make_id=new_run_id, mtime_of=lambda e: os.path.getmtime(os.path.join(config.INBOX, e))):
    """Import batch after batch; enrich once the inbox has gone quiet. Runs for ever in its own thread."""
    imported = False
    while True:
        batch = inbox.next_batch()
        log("auto import: %d entr%s" % (len(batch), "y" if len(batch) == 1 else "ies"))
        try:
            run("import", None, {"entries": batch}, make_id)
            imported = True
        except Exception as e:
            log("auto import crashed: %s" % e)
        # An entry still there after its run could not be moved; do not loop on it until it changes.
        inbox.block([e for e in batch if os.path.lexists(os.path.join(config.INBOX, e))], mtime_of)
        if imported and not inbox.waiting():
            try:
                run("enrich", None, None, make_id)
            except Exception as e:
                log("auto enrich crashed: %s" % e)
            imported = False


def start():
    """Starts the watcher threads when AUTO_IMPORT is on. Returns the Inbox, or None when it is off."""
    if not config.AUTO_IMPORT:
        return None
    inbox = Inbox(config.AUTO_IMPORT_DEBOUNCE)
    inbox.seed()
    threading.Thread(target=read_events, args=(inbox, inbox.touch), daemon=True).start()
    threading.Thread(target=pipeline, args=(inbox,), daemon=True).start()
    return inbox
