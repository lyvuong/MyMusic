#!/usr/bin/env python3
"""MyMusic home API: runs on the Unraid server next to Beets and does the work the web app asks for.

The Worker (Cloudflare) calls this through a Cloudflare Tunnel; nothing here polls. Every request needs the shared key
in the X-Agent-Key header. Endpoints (fixed; no paths or commands ever come from a request):

  GET  /health   -> {"ok": true, "busy": null | "import" | "enrich" | "youtube"}   checks that the beets container answers
  POST /edit     {"ops": [...]}  writes edited names into the files and the Beets library, waits for the result
  POST /cover    {"album": "...", "image": "<base64 jpeg>"}  writes cover.jpg into the folders of that album (embeds it when a folder is shared)
  POST /jobs     {"id": "...", "kind": "import" | "enrich"}  starts a long job and returns at once (202); progress and the
                 result are posted to the Worker (/api/beets/agent/progress and /report) under that run id
  POST /yt-info  {"url": "https://youtu.be/..."}  looks a YouTube video up (title, artist, duration) without downloading it
  POST /jobs     {"id": "...", "kind": "youtube", "url": "...", "title": "...", "artist": "...", "album": ""}  downloads the
                 audio with yt-dlp (in the yt-dlp container), tags it as given and imports it into Beets as it is

Needs: the docker CLI and /var/run/docker.sock (it runs `docker exec beets ...`), the inbox folder (read only, to count
files) and the host's /tmp (to share /tmp/beets-import.lock with beets-enrich.sh). See "Beets runs from the web app"
in the README for the compose entry.
"""
import fcntl
import hmac
import json
import os
import re
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
WORKER = os.environ.get("WORKER_URL", "https://mymusic.lv5.uk").rstrip("/")
BEETS = os.environ.get("BEETS_CONTAINER", "beets")
YTDLP = os.environ.get("YTDLP_CONTAINER", "yt-dlp")  # has yt-dlp + ffmpeg; mounts the inbox read-write as /downloads
YTDLP_ARGS = shlex.split(os.environ.get("YTDLP_ARGS", ""))  # extra yt-dlp options, e.g. "--js-runtimes node" if YouTube needs one
DOCKER = shlex.split(os.environ.get("DOCKER_CMD", "docker"))
INBOX = os.environ.get("INBOX", "/inbox")  # the folder Beets sees as /downloads
LOCK_PATH = os.environ.get("LOCK_PATH", "/host-tmp/beets-import.lock")
APPDATA = os.environ.get("BEETS_APPDATA", "/beets-appdata")
PORT = int(os.environ.get("PORT", "8099"))
EDIT_TIMEOUT = 85  # seconds; the Worker gives up at 95 and a Cloudflare Tunnel request at 100

# Both scripts below run inside the beets container with Beets' own Python and share these helpers.
COMMON_PY = r'''
import json, os, sys, unicodedata
from beets import config, ui

def nfc(s):
    return unicodedata.normalize("NFC", s or "").strip()

# Navidrome lists a song with no album or artist under these placeholders; Beets holds it as an empty string.
PLACEHOLDERS = ("[unknown album]", "[unknown artist]")

def same(a, b):
    """True when two names are the same after Unicode normalisation, an empty name matching Navidrome's placeholder."""
    a, b = nfc(a), nfc(b)
    a = "" if a.lower() in PLACEHOLDERS else a
    b = "" if b.lower() in PLACEHOLDERS else b
    return a == b

def resolve(path):
    """The file's real path when only the Unicode form of a name differs (NFC vs NFD), else None."""
    p = os.fsdecode(path)
    if os.path.exists(p):
        return path
    cur = os.path.splitdrive(p)[0] + os.sep
    for part in [x for x in os.path.splitdrive(p)[1].split(os.sep) if x]:
        nxt = os.path.join(cur, part)
        if not os.path.exists(nxt):
            try:
                names = os.listdir(cur)
            except OSError:
                return None
            hit = [n for n in names if nfc(n) == nfc(part)]
            if len(hit) != 1:
                return None
            nxt = os.path.join(cur, hit[0])
        cur = nxt
    return os.fsencode(cur) if os.path.exists(cur) else None

config.read(user=True, defaults=True)
lib = ui._open_library(config)
'''

# Writes edited names into the files and the Beets library.
# Files are NOT moved (a new path would give Navidrome a new song id and break playlists and ratings).
EDIT_PY = COMMON_PY + r'''
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
        old, new = op["from"], op["to"]
        for it in items:
            if same(it.album, old):
                it.album = new
                changed[it.id] = it
                if it.album_id:
                    album_fields.setdefault(it.album_id, {})["album"] = new
                n += 1
    elif kind == "artist":
        old, new = op["from"], op["to"]
        for it in items:
            hit = False
            if same(it.artist, old):
                it.artist, hit = new, True
            if same(it.albumartist, old):
                it.albumartist, hit = new, True
                if it.album_id:
                    album_fields.setdefault(it.album_id, {})["albumartist"] = new
            if hit:
                changed[it.id] = it
                n += 1
    elif kind == "song":
        m, s = op["match"], op["set"]
        found = [it for it in items
                 if same(it.title, m["title"]) and same(it.artist, m["artist"]) and same(it.album, m["album"])]
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
        real = resolve(it.path)
        if real is not None:
            if real != it.path:
                print("library path differs from the disk only in Unicode form, relinked: %s" % os.fsdecode(real))
                it.path = real
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

# Puts an image into each folder that holds the songs of an album, as cover.jpg (the name Navidrome looks for first).
# A folder shared with songs of other albums gets no folder image (it would apply to all of them): the image is embedded
# in the album's own song files instead.
COVER_PY = COMMON_PY + r'''
import base64
try:
    from mediafile import MediaFile, Image, ImageType
except ImportError:  # older Beets
    from beets.mediafile import MediaFile, Image, ImageType
req = json.load(sys.stdin)
album = req["album"]
data = base64.b64decode(req["image"])
IMAGES = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
NAMES = ("cover", "folder", "front")
folders = {}   # folder -> {"albums": set of album names, "ids": set of beets album ids of this album, "files": [paths]}
missing = []
for it in lib.items():
    real = resolve(it.path)
    if real is None:
        if same(it.album, album):
            missing.append(os.fsdecode(it.path))
        continue
    f = folders.setdefault(os.path.dirname(os.fsdecode(real)), {"albums": set(), "ids": set(), "files": []})
    f["albums"].add("" if same(it.album, "") else nfc(it.album))
    if same(it.album, album):
        f["files"].append(real)
        if it.album_id is not None:
            f["ids"].add(it.album_id)
skipped, shadowed, written, embedded, failed = [], [], 0, 0, 0
for folder, f in folders.items():
    if ("" if same(album, "") else nfc(album)) not in f["albums"]:
        continue
    if len(f["albums"]) > 1:
        # No folder image here; Navidrome only shows embedded art when the folder has no cover.*, folder.* or front.* image.
        try:
            for real in f["files"]:
                try:
                    mf = MediaFile(real, id3v23=bool(config["id3v23"].get()))  # as Beets itself opens files for writing
                except TypeError:
                    mf = MediaFile(real)
                mf.images = [Image(data=data, desc="", type=ImageType.front)]
                mf.save()
                embedded += 1
            if any(os.path.splitext(n)[0].lower() in NAMES and os.path.splitext(n)[1].lower() in IMAGES for n in os.listdir(folder)):
                shadowed.append(os.path.basename(folder))
            print("folder %s is shared with other albums: embedded the cover in %d file(s)" % (folder, len(f["files"])))
        except Exception as e:
            failed += 1
            skipped.append(os.path.basename(folder))
            print("could not embed the cover in %s: %s" % (folder, e))
        continue
    try:
        for name in os.listdir(folder):
            stem, ext = os.path.splitext(name)
            if stem.lower() in NAMES and ext.lower() in IMAGES:
                # kept, but under a name Navidrome does not treat as a cover
                os.replace(os.path.join(folder, name), os.path.join(folder, "old-" + name))
        dest = os.path.join(folder, "cover.jpg")
        tmp = dest + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dest)
        for aid in f["ids"]:
            alb = lib.get_album(aid)
            if alb is not None:
                alb.artpath = os.fsencode(dest)
                alb.store()
        written += 1
        print("cover written: %s" % dest)
    except Exception as e:
        failed += 1
        print("could not write the cover in %s: %s" % (folder, e))
print("RESULT " + json.dumps({"written": written, "embedded": embedded, "shadowed": shadowed, "failed": failed, "skipped": skipped, "missing": missing}))
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


def run_import(run_id, payload=None):
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


def run_enrich(run_id, payload=None):
    """Vietnamese tag fixes, cover art, art embedded in the files, and genres for albums that still lack them
    (same steps as beets-enrich.sh)."""
    lines = []
    exit_code = 0
    try:
        with beets_lock(7200):
            lines.append("=== %s enrich start (manual) ===\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            # fix-vietnamese.py is piped into the container's Python on stdin (it lives next to enrich.log).
            fix_script = os.path.join(APPDATA, "fix-vietnamese.py")
            steps = [(["beet", "fetchart"], None), (["beet", "embedart", "-y", "added:-14d.."], None), (["beet", "lastgenre"], None)]
            if os.path.exists(fix_script):
                steps.insert(0, (["/lsiopy/bin/python3", "-", "--apply"], fix_script))
            else:
                lines.append("fix-vietnamese.py not found in %s: skipping the Vietnamese tag fix\n" % APPDATA)
            for i, (cmd, stdin_path) in enumerate(steps):
                # Progress for the app: before = number of steps, now = steps still to do (the app shows "step k of n").
                worker_post("/api/beets/agent/progress", {"id": run_id, "before": len(steps), "now": len(steps) - i})
                if stdin_path:
                    with open(stdin_path, "rb") as script:
                        r = subprocess.run(DOCKER + ["exec", "-i", BEETS] + cmd, stdin=script, capture_output=True, text=True,
                                           encoding="utf-8", errors="replace")
                else:
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


# ---- YouTube --------------------------------------------------------------------------------------------------------

YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
YT_MAX_SECONDS = 2 * 3600
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def clean_url(url):
    """The link when it is one https YouTube video (not a playlist or channel), else None."""
    if not isinstance(url, str) or len(url) > 300 or any(c.isspace() or ord(c) < 32 for c in url):
        return None
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if u.scheme != "https" or host not in YT_HOSTS or u.username or u.password:
        return None
    if host == "youtu.be":
        ok = re.match(r"^/[\w-]+$", u.path) is not None
    else:
        ok = (u.path == "/watch" and bool(urllib.parse.parse_qs(u.query).get("v"))) or re.match(r"^/(shorts|live|embed)/[\w-]+$", u.path) is not None
    return url if ok else None


def clean_tag(value, limit=200):
    s = "".join(c for c in str(value or "") if c >= " " and c != "\x7f")
    return re.sub(r"\s+", " ", s).strip()[:limit]


def yt_info(url):
    """Asks yt-dlp about one video without downloading it. Returns (status, body)."""
    try:
        r = subprocess.run(
            DOCKER + ["exec", YTDLP, "yt-dlp"] + YTDLP_ARGS + ["--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download", "--", url],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except subprocess.TimeoutExpired:
        return 504, {"error": "YouTube did not answer in time. Try again."}
    except OSError as e:
        return 503, {"error": "Cannot run docker: %s" % e}
    if r.returncode != 0:
        last = (r.stderr.strip().splitlines() or ["no output"])[-1]
        return 502, {"error": "Could not read that video: %s" % last[:300]}
    try:
        d = json.loads(r.stdout)
    except ValueError:
        return 502, {"error": "yt-dlp returned something unreadable."}
    if not isinstance(d, dict) or d.get("_type") == "playlist":
        return 400, {"error": "That link is a playlist; paste the link of one video."}
    title = clean_tag(d.get("track") or d.get("title"))
    artist = clean_tag(d.get("artist") or d.get("creator") or "")
    if not artist and " - " in title:  # "Artist - Title" is the usual shape of a music upload's title
        artist, title = (clean_tag(x) for x in title.split(" - ", 1))
    if not artist:
        artist = clean_tag(d.get("uploader") or d.get("channel") or "")
    artist = re.sub(r"\s*-\s*Topic$", "", artist)
    duration = int(d.get("duration") or 0)
    return 200, {
        "title": title,
        "artist": artist,
        "album": clean_tag(d.get("album") or ""),
        "duration": duration,
        "thumbnail": d.get("thumbnail") if isinstance(d.get("thumbnail"), str) else None,
        "tooLong": duration > YT_MAX_SECONDS,
    }


def mp3s_in(folder):
    r = subprocess.run(DOCKER + ["exec", YTDLP, "find", folder, "-type", "f", "-name", "*.mp3"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout.split()


def run_youtube(run_id, payload):
    """Downloads one video's audio as mp3 into a private inbox sub-folder, tags it as the owner confirmed and imports it
    into Beets as it is (no MusicBrainz matching, so the names stay exactly as typed). Holds the Beets lock throughout,
    so an Organize or the nightly enrich never touches the half-written file."""
    title, artist, album = payload["title"], payload["artist"], payload["album"]
    folder = "/downloads/_youtube/%s" % run_id
    lines = ["YouTube import: %s - %s%s\n" % (artist, title, " [%s]" % album if album else "")]
    exit_code = 0
    meta = ["title=" + title, "artist=" + artist, "album_artist=" + artist] + (["album=" + album] if album else [])
    pp_args = "ffmpeg:" + " ".join("-metadata " + shlex.quote(m) for m in meta)
    steps = 2  # progress for the app: before = number of steps, now = steps still to do
    try:
        with beets_lock(3600):
            worker_post("/api/beets/agent/progress", {"id": run_id, "before": steps, "now": steps})
            r = subprocess.run(
                DOCKER + ["exec", YTDLP, "yt-dlp"] + YTDLP_ARGS + ["-x", "--audio-format", "mp3", "--audio-quality", "0", "--no-playlist",
                          "--embed-thumbnail", "--convert-thumbnails", "jpg", "--no-warnings",
                          "--match-filter", "duration<=%d" % YT_MAX_SECONDS, "--postprocessor-args", pp_args,
                          "-o", folder + "/%(id)s.%(ext)s", "--", payload["url"]],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
            )
            lines.append(r.stdout[-2000:] + r.stderr[-2000:])
            if r.returncode or not mp3s_in(folder):
                lines.append("Download failed (is the video longer than %d minutes, private, or blocked?).\n" % (YT_MAX_SECONDS // 60))
                exit_code = r.returncode or 1
            else:
                worker_post("/api/beets/agent/progress", {"id": run_id, "before": steps, "now": steps - 1})
                r = subprocess.run(
                    DOCKER + ["exec", BEETS, "beet", "-p", "fromfilename", "import", "-A", "-s", "-q", folder],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
                )
                lines.append(r.stdout[-2000:] + r.stderr[-2000:])
                if r.returncode:
                    exit_code = r.returncode
                elif mp3s_in(folder):
                    lines.append("Beets skipped the file (a song with these tags is probably already in the library).\n")
                    exit_code = 1
                else:
                    lines.append("Imported.\n")
            subprocess.run(DOCKER + ["exec", YTDLP, "rm", "-rf", folder], capture_output=True)
    except TimeoutError as e:
        lines.append("Gave up: %s\n" % e)
        exit_code = 1
    except subprocess.TimeoutExpired:
        lines.append("The download or import took too long and was stopped.\n")
        exit_code = 1
    except Exception as e:
        lines.append("YouTube import failed: %s\n" % e)
        exit_code = 1
    text = "".join(lines)
    append_file(os.path.join(APPDATA, "auto-import.log"), "=== %s youtube ===\n%s" % (time.strftime("%Y-%m-%d %H:%M:%S"), text))
    report(run_id, exit_code == 0, exit_code, text)


JOBS = {"import": run_import, "enrich": run_enrich, "youtube": run_youtube}
current = None  # {"kind", "id"} of the job running now
guard = threading.Lock()


def start_job(kind, run_id, payload=None):
    global current
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


# ---- Edits ----------------------------------------------------------------------------------------------------------

def do_edit(payload, script=None, what="edit"):
    """Runs an edit script in the beets container with the payload as JSON on stdin. Returns (status, body)."""
    script = script or EDIT_PY
    try:
        with beets_lock(10):
            try:
                p = subprocess.run(
                    DOCKER + ["exec", "-i", BEETS, "sh", "-c", LAUNCH, script],
                    input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=EDIT_TIMEOUT,
                )
            except subprocess.TimeoutExpired:
                return 504, {"error": "The %s took too long and was stopped. Some files may have changed; try again." % what}
            except OSError as e:
                return 503, {"error": "Cannot run docker: %s" % e}
    except TimeoutError as e:
        return 503, {"error": "Cannot %s right now: %s. Try again when it finishes." % (what, e)}
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
        return 500, {"error": "The %s failed: " % what + (text.strip().splitlines() or ["no output"])[-1][:300]}
    if p.returncode != 0 or result.get("failed"):
        return 500, {"error": "Could not write %d %s: %s" % (result.get("failed", 0), "folder(s)" if script is COVER_PY else "file(s)", text.strip()[-400:])}
    return 200, {"written": result.get("written", 0), "embedded": result.get("embedded", 0), "shadowed": result.get("shadowed", []), "skipped": result.get("skipped", []), "missing": result.get("missing", []), "log": text[-2000:]}


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
        if n > 6_000_000:  # a cover image, base64 encoded
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
        if self.path == "/cover":
            album, image = b.get("album"), b.get("image")
            if not isinstance(album, str) or not album.strip() or not isinstance(image, str) or not image:
                return self.send(400, {"error": "album and image (base64) are required"})
            return self.send(*do_edit({"album": album, "image": image}, COVER_PY, "cover update"))
        if self.path == "/yt-info":
            url = clean_url(b.get("url"))
            if not url:
                return self.send(400, {"error": "Paste the link of one YouTube video (https://youtu.be/... or youtube.com/watch?v=...)."})
            return self.send(*yt_info(url))
        if self.path == "/jobs":
            kind, run_id = b.get("kind"), b.get("id")
            if kind not in JOBS or not isinstance(run_id, str) or not RUN_ID_RE.match(run_id):
                return self.send(400, {"error": "kind must be import, enrich or youtube, with an id"})
            payload = None
            if kind == "youtube":
                url = clean_url(b.get("url"))
                title, artist, album = clean_tag(b.get("title")), clean_tag(b.get("artist")), clean_tag(b.get("album"))
                if not url or not title or not artist:
                    return self.send(400, {"error": "a YouTube video link, a title and an artist are required"})
                payload = {"url": url, "title": title, "artist": artist, "album": album}
            ok, why = start_job(kind, run_id, payload)
            return self.send(202, {"id": run_id}) if ok else self.send(409, {"error": why})
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    log("mymusic-api listening on :%d (worker %s, container %s)" % (PORT, WORKER, BEETS))
    if not os.path.isdir(INBOX):
        log("WARNING: %s does not exist; mount the inbox (see README) or the progress bar will stay empty" % INBOX)
    else:
        log("inbox %s holds %d file(s)" % (INBOX, count_inbox()))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
