#!/usr/bin/env python3
"""MyMusic home API: runs on the Unraid server next to Beets and does the work the web app asks for.

The Worker (Cloudflare) calls this through a Cloudflare Tunnel; nothing here polls. Every request needs the shared key
in the X-Agent-Key header. Endpoints (fixed; no paths or commands ever come from a request):

  GET  /health   -> {"ok": true, "busy": null | "import" | "enrich"}   checks that the beets container answers
  POST /edit     {"ops": [...]}  writes edited names into the files and the Beets library, waits for the result
  POST /jobs     {"id": "...", "kind": "import" | "enrich"}  starts a long job and returns at once (202); progress and the
                 result are posted to the Worker (/api/beets/agent/progress and /report) under that run id

Needs: the docker CLI and /var/run/docker.sock (it runs `docker exec beets ...`), the inbox folder (read only, to count
files) and the host's /tmp (to share /tmp/beets-import.lock with beets-enrich.sh). See "Beets runs from the web app"
in the README for the compose entry.
"""
import fcntl
import hmac
import json
import os
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = (os.environ.get("AGENT_KEY") or open(os.environ.get("KEY_FILE", "/run/mymusic-agent.key")).read()).strip()
WORKER = os.environ.get("WORKER_URL", "https://mymusic.lyvuong.workers.dev").rstrip("/")
BEETS = os.environ.get("BEETS_CONTAINER", "beets")
DOCKER = shlex.split(os.environ.get("DOCKER_CMD", "docker"))
INBOX = os.environ.get("INBOX", "/inbox")  # the folder Beets sees as /downloads
LOCK_PATH = os.environ.get("LOCK_PATH", "/host-tmp/beets-import.lock")
APPDATA = os.environ.get("BEETS_APPDATA", "/beets-appdata")
PORT = int(os.environ.get("PORT", "8099"))
EDIT_TIMEOUT = 85  # seconds; the Worker gives up at 95 and a Cloudflare Tunnel request at 100

# Runs inside the beets container with Beets' own Python: writes tags into the files and updates the Beets library.
# Files are NOT moved (a new path would give Navidrome a new song id and break playlists and ratings).
EDIT_PY = r'''
import json, os, sys, unicodedata
from beets import config, ui

def nfc(s):
    return unicodedata.normalize("NFC", s or "").strip()

config.read(user=True, defaults=True)
lib = ui._open_library(config)
ops = json.load(sys.stdin)
items = list(lib.items())
changed = {}
album_fields = {}   # album id -> {field: value} for album and artist renames
skipped = []
missing = []   # in the Beets library but gone from the disk: the library entry is updated, no file is written
failed = 0

for op in ops:
    kind, n = op.get("kind"), 0
    if kind == "album":
        old, new = nfc(op["from"]), op["to"]
        for it in items:
            if nfc(it.album) == old:
                it.album = new
                changed[it.id] = it
                if it.album_id:
                    album_fields.setdefault(it.album_id, {})["album"] = new
                n += 1
    elif kind == "artist":
        old, new = nfc(op["from"]), op["to"]
        for it in items:
            hit = False
            if nfc(it.artist) == old:
                it.artist, hit = new, True
            if nfc(it.albumartist) == old:
                it.albumartist, hit = new, True
                if it.album_id:
                    album_fields.setdefault(it.album_id, {})["albumartist"] = new
            if hit:
                changed[it.id] = it
                n += 1
    elif kind == "song":
        m, s = op["match"], op["set"]
        found = [it for it in items
                 if nfc(it.title) == nfc(m["title"]) and nfc(it.artist) == nfc(m["artist"]) and nfc(it.album) == nfc(m["album"])]
        if len(found) > 1 and m.get("trackNo"):
            found = [it for it in found if it.track == m["trackNo"]] or found
        if len(found) == 1:
            it = found[0]
            for key, field in (("title", "title"), ("artist", "artist"), ("album", "album"), ("trackNo", "track")):
                if key in s:
                    setattr(it, field, s[key])
            changed[it.id] = it
            n = 1
        else:
            skipped.append(m["title"])
            print("song %r: %d matches, skipped" % (m["title"], len(found)))
    print("%s: %d file(s)" % (kind, n))

for it in changed.values():
    try:
        if os.path.exists(it.path):
            it.write()
        else:
            missing.append(os.fsdecode(it.path))
            print("file is missing on disk, only the library entry was updated: %s" % os.fsdecode(it.path))
        it.store()
    except Exception as e:
        failed += 1
        print("could not write %s: %s" % (it.path, e))
for album_id, fields in album_fields.items():
    alb = lib.get_album(album_id)
    if alb is not None:
        for k, v in fields.items():
            alb[k] = v
        alb.store()
print("RESULT " + json.dumps({"written": len(changed) - failed - len(missing), "failed": failed, "skipped": skipped, "missing": missing}))
sys.exit(1 if failed else 0)
'''

# Runs the script above with the interpreter beets itself uses (read from the `beet` launcher).
LAUNCH = 'PYBIN=$(head -n1 "$(command -v beet)" | sed "s/^#!//"); exec $PYBIN -c "$0"'


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, file=sys.stderr, flush=True)


# ---- Locking: never run two things against the Beets library at once ------------------------------------------------

@contextmanager
def beets_lock(wait):
    """Holds /tmp/beets-import.lock (shared with beets-enrich.sh) or raises TimeoutError after `wait` seconds."""
    f = open(LOCK_PATH, "w")
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


# ---- Talking back to the Worker -------------------------------------------------------------------------------------

def worker_post(path, query=None, body=None, tries=1):
    url = WORKER + path + ("?" + urllib.parse.urlencode(query) if query else "")
    for attempt in range(tries):
        req = urllib.request.Request(url, data=body if body is not None else b"", method="POST")
        req.add_header("X-Agent-Key", KEY)
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


# ---- Long jobs ------------------------------------------------------------------------------------------------------

def count_inbox():
    return sum(len(files) for _, _, files in os.walk(INBOX))


def append_file(path, text):
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)
    except OSError as e:
        log("cannot write %s: %s" % (path, e))


def run_import(run_id):
    """The Organize button: pass 1 groups files into albums by their tags, pass 2 imports leftovers one by one.
    Only musicbrainz, scrub and fromfilename load, so it is fast; enrich adds art and genres."""
    before = count_inbox()
    log("import %s: %d file(s) in %s" % (run_id, before, INBOX))
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
                    DOCKER + ["exec", BEETS, "beet", "-p", "musicbrainz,scrub,fromfilename", "import", flag, "-q", "/downloads"],
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
    append_file(os.path.join(APPDATA, "auto-import.log"), text)
    report(run_id, exit_code == 0, exit_code, text or "(no output: nothing to import)", before, count_inbox())


def run_enrich(run_id):
    """Cover art, art embedded in the files, and genres for albums that still lack them (same steps as beets-enrich.sh)."""
    lines = []
    exit_code = 0
    try:
        with beets_lock(7200):
            lines.append("=== %s enrich start (manual) ===\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            steps = (["beet", "fetchart"], ["beet", "embedart", "-y", "added:-14d.."], ["beet", "lastgenre"])
            for i, cmd in enumerate(steps):
                # Progress for the app: before = number of steps, now = steps still to do (the app shows "step k of n").
                worker_post("/api/beets/agent/progress", {"id": run_id, "before": len(steps), "now": len(steps) - i})
                r = subprocess.run(DOCKER + ["exec", BEETS] + cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
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
    append_file(os.path.join(APPDATA, "enrich.log"), text)
    report(run_id, exit_code == 0, exit_code, text)


JOBS = {"import": run_import, "enrich": run_enrich}
current = None  # {"kind", "id"} of the job running now
guard = threading.Lock()


def start_job(kind, run_id):
    global current
    with guard:
        if current:
            return False, "Another job (%s) is already running on the server." % current["kind"]
        current = {"kind": kind, "id": run_id}

    def work():
        global current
        try:
            JOBS[kind](run_id)
        except Exception as e:
            log("job %s crashed: %s" % (run_id, e))
            report(run_id, False, 1, "The job crashed: %s" % e)
        finally:
            with guard:
                current = None

    threading.Thread(target=work, daemon=True).start()
    return True, ""


# ---- Edits ----------------------------------------------------------------------------------------------------------

def do_edit(ops):
    """Returns (status, body)."""
    try:
        with beets_lock(10):
            try:
                p = subprocess.run(
                    DOCKER + ["exec", "-i", BEETS, "sh", "-c", LAUNCH, EDIT_PY],
                    input=json.dumps(ops), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=EDIT_TIMEOUT,
                )
            except subprocess.TimeoutExpired:
                return 504, {"error": "Writing the tags took too long and was stopped. Some files may have changed; try again."}
            except OSError as e:
                return 503, {"error": "Cannot run docker: %s" % e}
    except TimeoutError as e:
        return 503, {"error": "Cannot edit right now: %s. Try again when it finishes." % e}
    text = p.stdout + p.stderr
    append_file(os.path.join(APPDATA, "tag-edits.log"), "=== %s ===\n%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), text))
    result = None
    for line in text.splitlines():
        if line.startswith("RESULT "):
            try:
                result = json.loads(line[7:])
            except ValueError:
                pass
    if result is None:
        return 500, {"error": "Writing the tags failed: " + (text.strip().splitlines() or ["no output"])[-1][:300]}
    if p.returncode != 0 or result.get("failed"):
        return 500, {"error": "Could not write %d file(s): %s" % (result.get("failed", 0), text.strip()[-400:])}
    return 200, {"written": result.get("written", 0), "skipped": result.get("skipped", []), "missing": result.get("missing", []), "log": text[-2000:]}


def health():
    try:
        r = subprocess.run(DOCKER + ["exec", BEETS, "true"], capture_output=True, text=True, timeout=8)
    except (subprocess.TimeoutExpired, OSError) as e:
        return 503, {"error": "Cannot run docker: %s" % e}
    if r.returncode != 0:
        return 503, {"error": "The '%s' container is not running." % BEETS}
    return 200, {"ok": True, "busy": current["kind"] if current else None}


# ---- HTTP -----------------------------------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "mymusic-api"

    def log_message(self, fmt, *args):
        log("%s %s" % (self.address_string(), fmt % args))

    def send(self, status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        given = self.headers.get("X-Agent-Key", "")
        if hmac.compare_digest(given.encode("utf-8"), KEY.encode("utf-8")):
            return True
        self.send(401, {"error": "unauthorized"})
        return False

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return None

    def do_GET(self):
        if not self.authed():
            return
        try:
            if self.path == "/health":
                return self.send(*health())
            self.send(404, {"error": "not found"})
        except Exception as e:  # always answer, so the caller sees the reason instead of a dropped connection
            log("GET %s crashed: %r" % (self.path, e))
            self.send(500, {"error": "Server error: %s" % e})

    def do_POST(self):
        try:
            self.post()
        except Exception as e:
            log("POST %s crashed: %r" % (self.path, e))
            self.send(500, {"error": "Server error: %s" % e})

    def post(self):
        if not self.authed():
            return
        b = self.body()
        if not isinstance(b, dict):
            return self.send(400, {"error": "bad request"})
        if self.path == "/edit":
            ops = b.get("ops")
            if not isinstance(ops, list) or not ops or len(ops) > 500 or not all(isinstance(o, dict) for o in ops):
                return self.send(400, {"error": "ops must be a list of 1-500 edits"})
            return self.send(*do_edit(ops))
        if self.path == "/jobs":
            kind, run_id = b.get("kind"), b.get("id")
            if kind not in JOBS or not isinstance(run_id, str) or not run_id:
                return self.send(400, {"error": "kind must be import or enrich, with an id"})
            ok, why = start_job(kind, run_id)
            return self.send(202, {"id": run_id}) if ok else self.send(409, {"error": why})
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    log("mymusic-api listening on :%d (worker %s, container %s)" % (PORT, WORKER, BEETS))
    if not os.path.isdir(INBOX):
        log("WARNING: %s does not exist; mount the inbox (see README) or the progress bar will stay empty" % INBOX)
    else:
        log("inbox %s holds %d file(s)" % (INBOX, count_inbox()))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
