"""Settings of the home API, all from the environment (see the compose entry in the README)."""
import os
import re
import shlex

KEY = (os.environ.get("AGENT_KEY") or open(os.environ.get("KEY_FILE", "/run/mymusic-agent.key")).read()).strip()
WORKER = os.environ.get("WORKER_URL", "https://mymusic.lv5.uk").rstrip("/")
BEETS = os.environ.get("BEETS_CONTAINER", "beets")
YTDLP = os.environ.get("YTDLP_CONTAINER", "yt-dlp")  # has yt-dlp + ffmpeg; mounts the inbox read-write as /downloads
YTDLP_ARGS = shlex.split(os.environ.get("YTDLP_ARGS", "--js-runtimes node"))  # the yt-dlp container installs nodejs; yt-dlp only uses deno unless told; set YTDLP_ARGS= to pass nothing
DOCKER = shlex.split(os.environ.get("DOCKER_CMD", "docker"))
INBOX = os.environ.get("INBOX", "/inbox")  # the folder Beets sees as /downloads
LOCK_PATH = os.environ.get("LOCK_PATH", "/host-tmp/beets-import.lock")
APPDATA = os.environ.get("BEETS_APPDATA", "/beets-appdata")
PORT = int(os.environ.get("PORT", "8099"))
EDIT_TIMEOUT = 85  # seconds; the Worker gives up at 95 and a Cloudflare Tunnel request at 100
MAX_YT = max(1, int(os.environ.get("MAX_YT", "3")))  # YouTube downloads running at the same time
AUTO_IMPORT = os.environ.get("AUTO_IMPORT", "") in ("1", "true", "yes")  # watch the inbox and import by itself
AUTO_IMPORT_DEBOUNCE = float(os.environ.get("AUTO_IMPORT_DEBOUNCE", "20"))  # seconds an entry must be quiet before it is imported

VERSION = os.environ.get("MYMUSIC_API_VERSION", "dev")  # the git commit of the image, baked in by CI

RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
