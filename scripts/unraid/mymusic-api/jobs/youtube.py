"""YouTube: look a video up, and download + tag + import it as one song."""
import json
import os
import re
import shlex
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

import config
from locks import beets_lock
from reporting import report, worker_post
from util import append_file, log

YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
YT_MAX_SECONDS = 2 * 3600


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


def clean_playlist_url(url):
    """The link when it is a YouTube / YouTube Music playlist page (youtube.com/playlist?list=...), else None."""
    if not isinstance(url, str) or len(url) > 300 or any(c.isspace() or ord(c) < 32 for c in url):
        return None
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if u.scheme != "https" or host not in YT_HOSTS - {"youtu.be"} or u.username or u.password or u.path != "/playlist":
        return None
    lst = urllib.parse.parse_qs(u.query).get("list")
    return "https://%s/playlist?list=%s" % (host, lst[0]) if lst and re.match(r"^[\w-]{10,60}$", lst[0]) else None


def clean_tag(value, limit=200):
    s = "".join(c for c in str(value or "") if c >= " " and c != "\x7f")
    return re.sub(r"\s+", " ", s).strip()[:limit]


# Words that mark bracketed or trailing "(Official Video)"-style noise in an upload's title.
NOISE = r"official|video|audio|mv|m/v|lyrics?|lyric video|hd|hq|4k|8k|1080p|remaster(?:ed)?|visuali[sz]er|music video"
NOISE_BRACKET = re.compile(r"\s*[\(\[【][^\)\]】]*\b(?:%s)\b[^\)\]】]*[\)\]】]" % NOISE, re.I)
NOISE_TAIL = re.compile(r"\s*[-|–—]\s*(?:%s)\b.*$" % NOISE, re.I)


AI_HINT = re.compile(r"\b(suno|udio|ai[ -]?generated|generated (?:by|with|using) ai|(?:made|created|produced|composed) (?:by|with|using) ai|ai (?:music|song|cover|vocals?))\b", re.I)


def yt_video_id(url):
    u = urllib.parse.urlsplit(url)
    if (u.hostname or "").lower() == "youtu.be":
        return u.path.strip("/")
    q = urllib.parse.parse_qs(u.query).get("v")
    return q[0] if q else u.path.rstrip("/").rsplit("/", 1)[-1]


def ai_label_in(html):
    """True when the watch page carries YouTube's "How this was made" panel saying the sounds or visuals were altered or
    generated (the "Made with AI" label creators must set, which YouTube also sets itself). English text, so the page is
    requested with hl=en; the panel's key name does not change with the language."""
    i = html.find('"howThisWasMadeSectionViewModel":{')  # the panel itself; the bare name also sits in a list of renderer names
    if i < 0:
        return False
    return bool(re.search(r"altered or (?:fully )?generated|made with ai|altered or synthetic|synthetic", html[i:i + 3000], re.I))


def yt_ai_label(url):
    """Reads YouTube's own AI label for a video (yt-dlp does not expose it). False when unknown or on any error."""
    vid = yt_video_id(url)
    if not re.match(r"^[\w-]{6,20}$", vid):
        return False
    req = urllib.request.Request(
        "https://www.youtube.com/watch?v=%s&hl=en" % vid,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Cookie": "CONSENT=YES+1; SOCS=CAI",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return ai_label_in(r.read(4_000_000).decode("utf-8", errors="replace"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        log("AI label lookup failed: %s" % e)
        return False


def tidy_title(title, artist=""):
    """Drops "(Official Video)", "[4K Remaster]", "| Lyrics" noise, a leading "Artist - ", and anything after a second
    " - " ("Artist - Song - Playlist name - Channel" becomes "Song")."""
    t = NOISE_BRACKET.sub("", title)
    t = NOISE_TAIL.sub("", t)
    t = re.sub(r"\s+", " ", t).strip(" -|")
    if artist and t.lower().startswith(artist.lower() + " - "):
        t = t[len(artist) + 3:]
    return t.split(" - ")[0].strip() or title


def yt_info(url):
    """Asks yt-dlp about one video without downloading it. Returns (status, body)."""
    try:
        r = subprocess.run(
            config.DOCKER + ["exec", config.YTDLP, "yt-dlp"] + config.YTDLP_ARGS + ["--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download", "--", url],
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
        artist, title = (clean_tag(x) for x in re.sub(r"\s+", " ", NOISE_BRACKET.sub("", title)).split(" - ", 1))
    if not artist:
        artist = clean_tag(d.get("uploader") or d.get("channel") or "")
    artist = re.sub(r"\s*-\s*Topic$", "", artist)
    title = tidy_title(title, artist)
    duration = int(d.get("duration") or 0)
    return 200, {
        "title": title,
        "artist": artist,
        "album": clean_tag(d.get("album") or ""),
        "duration": duration,
        "thumbnail": d.get("thumbnail") if isinstance(d.get("thumbnail"), str) else None,
        "tooLong": duration > YT_MAX_SECONDS,
        "aiLabel": yt_ai_label(url),
        "aiHint": bool(AI_HINT.search(" ".join([str(d.get("title") or ""), str(d.get("description") or "")[:3000], " ".join(str(x) for x in (d.get("tags") or []))]))),
    }


YT_PLAYLIST_MAX = 500


def yt_playlist(url):
    """Lists the videos of a playlist without downloading anything. Returns (status, body)."""
    try:
        r = subprocess.run(
            config.DOCKER + ["exec", config.YTDLP, "yt-dlp"] + config.YTDLP_ARGS + ["--flat-playlist", "--dump-single-json", "--no-warnings", "--playlist-end", str(YT_PLAYLIST_MAX), "--", url],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )
    except subprocess.TimeoutExpired:
        return 504, {"error": "YouTube did not answer in time. Try again."}
    except OSError as e:
        return 503, {"error": "Cannot run docker: %s" % e}
    if r.returncode != 0:
        last = (r.stderr.strip().splitlines() or ["no output"])[-1]
        return 502, {"error": "Could not read that playlist: %s" % last[:300]}
    try:
        d = json.loads(r.stdout)
    except ValueError:
        return 502, {"error": "yt-dlp returned something unreadable."}
    items, skipped = [], 0
    for e in (d.get("entries") or []) if isinstance(d, dict) else []:
        vid = e.get("id") if isinstance(e, dict) else None
        title = clean_tag(e.get("title")) if isinstance(e, dict) else ""
        if not isinstance(vid, str) or not re.match(r"^[\w-]{6,20}$", vid) or title.lower() in ("[private video]", "[deleted video]"):
            skipped += 1
            continue
        items.append({"url": "https://www.youtube.com/watch?v=" + vid, "title": title, "duration": int(e.get("duration") or 0)})
    if not items:
        return 404, {"error": "No videos found in that playlist (is it private?)."}
    return 200, {"title": clean_tag(d.get("title")), "items": items, "skipped": skipped}


def mp3s_in(folder):
    r = subprocess.run(config.DOCKER + ["exec", config.YTDLP, "find", folder, "-type", "f", "-name", "*.mp3"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout.split()


def embed_cover(folder, cover):
    """Embeds a square cover in the downloaded mp3: the real cover the Worker found, else the video's thumbnail cropped to
    a square. Never fails the import: without a cover the song is simply added as it is. Returns a log line."""
    exec_ = config.DOCKER + ["exec", config.YTDLP]
    what = "the cover found online"
    try:
        mp3 = mp3s_in(folder)[0]
        src = folder + "/cover_src.jpg"
        if cover:
            subprocess.run(config.DOCKER + ["exec", "-i", config.YTDLP, "sh", "-c", 'cat > "$0"', src], input=cover, capture_output=True, timeout=60, check=True)
        else:
            what = "the video thumbnail, cropped square"
            thumbs = subprocess.run(exec_ + ["find", folder, "-type", "f", "-name", "*.jpg"], capture_output=True, text=True).stdout.split()
            if not thumbs:
                return "No cover available.\n"
            src = thumbs[0]
        out = mp3 + ".cover.mp3"
        r = subprocess.run(
            exec_ + ["ffmpeg", "-y", "-loglevel", "error", "-i", mp3, "-i", src, "-map", "0:a", "-map", "1:v", "-c:a", "copy",
                     "-c:v", "mjpeg", "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=600:600", "-id3v2_version", "3",
                     "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)", out],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )
        if r.returncode:
            return "Could not embed a cover: %s\n" % (r.stderr.strip().splitlines() or ["ffmpeg failed"])[-1][:200]
        subprocess.run(exec_ + ["mv", "-f", out, mp3], capture_output=True, check=True)
        return "Cover embedded (%s).\n" % what
    except (subprocess.SubprocessError, OSError, IndexError) as e:
        return "Could not embed a cover: %s\n" % e


def run_youtube(run_id, payload):
    """Downloads one video's audio as mp3 into a private inbox sub-folder, tags it as the owner confirmed and imports it
    into Beets as it is (no MusicBrainz matching, so the names stay exactly as typed). Several of these run at once: the
    download, tagging and cover work only touch this run's folder. Only the last step, the Beets import, takes the
    library lock (it writes the library database), so it waits for a running Organize or enrich, and the other way round.
    Organize never looks into _youtube, so it cannot pick up a half-written file."""
    title, artist, album = payload["title"], payload["artist"], payload["album"]
    folder = "/downloads/_youtube/%s" % run_id
    lines = ["YouTube import: %s - %s%s\n" % (artist, title, " [%s]" % album if album else "")]
    exit_code = 0
    meta = ["title=" + title, "artist=" + artist, "album_artist=" + artist] + (["album=" + album] if album else [])
    pp_args = "ffmpeg:" + " ".join("-metadata " + shlex.quote(m) for m in meta)
    steps = 2  # progress for the app: before = number of steps, now = steps still to do
    try:
        worker_post("/api/beets/agent/progress", {"id": run_id, "before": steps, "now": steps})
        r = subprocess.run(
            config.DOCKER + ["exec", config.YTDLP, "yt-dlp"] + config.YTDLP_ARGS + ["-x", "--audio-format", "mp3", "--audio-quality", "0", "--no-playlist",
                      "--write-thumbnail", "--convert-thumbnails", "jpg", "--no-warnings",
                      "--match-filter", "duration<=%d" % YT_MAX_SECONDS, "--postprocessor-args", pp_args,
                      "-o", folder + "/%(id)s.%(ext)s", "--", payload["url"]],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
        )
        lines.append(r.stdout[-2000:] + r.stderr[-2000:])
        if r.returncode or not mp3s_in(folder):
            lines.append("Download failed (is the video longer than %d minutes, private, or blocked?).\n" % (YT_MAX_SECONDS // 60))
            exit_code = r.returncode or 1
        else:
            lines.append(embed_cover(folder, payload.get("cover")))
            worker_post("/api/beets/agent/progress", {"id": run_id, "before": steps, "now": steps - 1})
            with beets_lock(3600):
                r = subprocess.run(
                    config.DOCKER + ["exec", config.BEETS, "beet", "-p", "fromfilename", "import", "-A", "-s", "-q", folder],
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
    except TimeoutError as e:
        lines.append("Gave up: %s\n" % e)
        exit_code = 1
    except subprocess.TimeoutExpired:
        lines.append("The download or import took too long and was stopped.\n")
        exit_code = 1
    except Exception as e:
        lines.append("YouTube import failed: %s\n" % e)
        exit_code = 1
    finally:
        subprocess.run(config.DOCKER + ["exec", config.YTDLP, "rm", "-rf", folder], capture_output=True)
    text = "".join(lines)
    append_file(os.path.join(config.APPDATA, "auto-import.log"), "=== %s youtube ===\n%s" % (time.strftime("%Y-%m-%d %H:%M:%S"), text))
    report(run_id, exit_code == 0, exit_code, text)


def clear_leftovers():
    """At startup: downloads of runs that died with the previous process are no use to anyone."""
    root = os.path.join(config.INBOX, "_youtube")
    try:
        names = os.listdir(root)
    except OSError:
        return
    for name in names:
        log("removing the unfinished download %s" % name)
        try:
            subprocess.run(config.DOCKER + ["exec", config.YTDLP, "rm", "-rf", "/downloads/_youtube/" + name], capture_output=True, timeout=60)
        except (subprocess.SubprocessError, OSError) as e:
            log("could not remove %s: %s" % (name, e))
