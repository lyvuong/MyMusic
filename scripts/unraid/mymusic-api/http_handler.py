"""The HTTP side: authentication, routing and the request checks."""
import base64
import hmac
import json
import subprocess
from http.server import BaseHTTPRequestHandler

import config
from edit import COVER_PY, do_edit
from jobs import JOBS
from jobs.youtube import clean_tag, clean_url, yt_info
from locks import busy_kind, start_job
from util import log


def health():
    try:
        r = subprocess.run(config.DOCKER + ["exec", config.BEETS, "true"], capture_output=True, text=True, timeout=8)
    except (subprocess.TimeoutExpired, OSError) as e:
        return 503, {"error": "Cannot run docker: %s" % e}
    if r.returncode != 0:
        return 503, {"error": "The '%s' container is not running." % config.BEETS}
    return 200, {"ok": True, "busy": busy_kind()}


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
        if hmac.compare_digest(given.encode("utf-8"), config.KEY.encode("utf-8")):
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
            if kind not in JOBS or not isinstance(run_id, str) or not config.RUN_ID_RE.match(run_id):
                return self.send(400, {"error": "kind must be import, enrich or youtube, with an id"})
            payload = None
            if kind == "youtube":
                url = clean_url(b.get("url"))
                title, artist, album = clean_tag(b.get("title")), clean_tag(b.get("artist")), clean_tag(b.get("album"))
                if not url or not title or not artist:
                    return self.send(400, {"error": "a YouTube video link, a title and an artist are required"})
                cover = None
                if isinstance(b.get("cover"), str) and b["cover"]:
                    try:
                        raw = base64.b64decode(b["cover"], validate=True)
                    except ValueError:
                        raw = b""
                    if 0 < len(raw) <= 3_000_000 and (raw[:3] == b"\xff\xd8\xff" or raw[:4] == b"\x89PNG"):
                        cover = raw
                payload = {"url": url, "title": title, "artist": artist, "album": album, "cover": cover}
            ok, why = start_job(kind, run_id, payload)
            return self.send(202, {"id": run_id}) if ok else self.send(409, {"error": why})
        self.send(404, {"error": "not found"})
