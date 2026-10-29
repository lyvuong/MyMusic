"""Writing edited names and covers into the files and the Beets library (the web app's name editor)."""
import json
import os
import subprocess
import time

import config
from locks import beets_lock
from util import append_file

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

# Deletes duplicate copies of songs: the files and their Beets library entries (and an album left empty). Each group names
# the copy to keep, which must be in the library, and the copies to remove; a copy is removed only when exactly one library
# song matches its names (and length, if several share them) and it is not the kept one. Nothing outside /music is touched.
DELETE_PY = COMMON_PY + r'''
groups = json.load(sys.stdin)
items = list(lib.items())
MUSIC = "/music/"

def find(m):
    # The file's path inside the music folder (from Navidrome) tells two copies with the same names apart exactly.
    rel = nfc(m.get("path") or "").lstrip("/")
    if rel:
        return [it for it in items if nfc(os.fsdecode(it.path)).endswith("/" + rel)]
    found = [it for it in items if same(it.title, m["title"]) and same(it.artist, m["artist"]) and same(it.album, m["album"])]
    if len(found) > 1 and m.get("trackNo"):
        found = [it for it in found if it.track == m["trackNo"]] or found
    if len(found) > 1 and m.get("duration"):
        found = [it for it in found if abs((it.length or 0) - m["duration"]) <= 3.0] or found
    return found

out = []
for g in groups:
    keep = find(g["keep"])
    keep_ids = {it.id for it in keep}
    for m in g["remove"]:
        row = {"title": m["title"], "album": m["album"], "status": "", "why": ""}
        found = find(m)
        if not keep:
            row["status"], row["why"] = "skipped", "the copy to keep was not found in the Beets library"
        elif len(found) != 1:
            row["status"], row["why"] = "skipped", "not found in the Beets library" if not found else "several songs share these names"
        elif found[0].id in keep_ids:
            row["status"], row["why"] = "skipped", "it is the same library song as the one to keep"
        else:
            it = found[0]
            try:
                real = resolve(it.path)
                if real is None:
                    it.remove(delete=False)
                    row["status"], row["why"] = "deleted", "the file was already gone; the library entry was removed"
                elif not os.fsdecode(real).startswith(MUSIC):
                    row["status"], row["why"] = "skipped", "the file is outside the music folder"
                else:
                    if real != it.path:
                        it.path = real
                        it.store()
                    path = os.fsdecode(real)
                    it.remove(delete=True)
                    row["status"] = "deleted"
                    print("deleted %s" % path)
            except Exception as e:
                row["status"], row["why"] = "failed", str(e)
                print("could not delete %s: %s" % (m["title"], e))
        out.append(row)
print("RESULT " + json.dumps(out))
'''


# Runs the script above with the interpreter beets itself uses (read from the `beet` launcher).
LAUNCH = 'PYBIN=$(head -n1 "$(command -v beet)" | sed "s/^#!//"); exec $PYBIN -c "$0"'


# Decides, for files an import skipped as duplicates, which really are the same song as one already in the library:
# same title and artist (from the tags, else an "Artist - Title" file name) and a length within 3 seconds. A file that
# cannot be confirmed (no names, unreadable, a different length such as a remix) is reported as not a duplicate.
CONFIRM_PY = COMMON_PY + r"""
try:
    from mediafile import MediaFile
except ImportError:  # older Beets
    from beets.mediafile import MediaFile
paths = json.load(sys.stdin)
index = {}   # (title, artist) lower-cased -> lengths of the library songs with those names
for it in lib.items():
    index.setdefault((nfc(it.title).lower(), nfc(it.artist).lower()), []).append(it.length or 0)
out = []
for p in paths:
    try:
        mf = MediaFile(os.fsencode(p))
        title, artist, length = nfc(mf.title), nfc(mf.artist or mf.albumartist), float(mf.length or 0)
    except Exception as e:
        out.append({"path": p, "dup": False, "why": "unreadable: %s" % e})
        continue
    if not title:
        stem = os.path.splitext(os.path.basename(p))[0]
        if " - " in stem:
            artist, title = (nfc(x) for x in stem.split(" - ", 1))
    if not title:
        out.append({"path": p, "dup": False, "why": "no title to compare"})
        continue
    lengths = index.get((title.lower(), artist.lower()), [])
    if not lengths:
        out.append({"path": p, "dup": False, "why": "no song with these names in the library"})
    elif any(abs(l - length) <= 3.0 for l in lengths):
        out.append({"path": p, "dup": True, "why": "same names and length as a song in the library"})
    else:
        out.append({"path": p, "dup": False, "why": "same names but a different length (%.0fs; the library has %s)" % (length, ", ".join("%.0fs" % l for l in lengths))})
print("RESULT " + json.dumps(out))
"""


# Identifies songs by their sound: Chromaprint (fpcalc, in the beets image) + AcoustID, which answers with the MusicBrainz
# recordings and the release groups (albums) they appear on. Read-only: nothing is written to files or the library.
FINGERPRINT_PY = COMMON_PY + r'''
import acoustid
songs = json.load(sys.stdin)
try:
    from beetsplug import chroma
    key = getattr(chroma, "API_KEY", None)
except Exception:
    key = None
key = os.environ.get("ACOUSTID_KEY") or key or "1vOwZtEn"
items = list(lib.items())
out = []
for m in songs:
    found = [it for it in items if same(it.title, m["title"]) and same(it.artist, m["artist"]) and same(it.album, m["album"])]
    if len(found) > 1 and m.get("trackNo"):
        found = [it for it in found if it.track == m["trackNo"]] or found
    row = {"matches": [], "why": ""}
    if len(found) != 1:
        row["why"] = "the song was not found in the Beets library" if not found else "several songs share these names"
    else:
        path = resolve(found[0].path)
        if path is None:
            row["why"] = "the file is missing from the disk"
        else:
            try:
                duration, fp = acoustid.fingerprint_file(os.fsdecode(path))
                res = acoustid.lookup(key, fp, duration, meta="recordings releasegroups")
                for r in res.get("results", []):
                    for rec in r.get("recordings", []):
                        artists = " & ".join(a.get("name", "") for a in rec.get("artists", []) if a.get("name"))
                        groups = [g.get("title", "") for g in rec.get("releasegroups", []) if g.get("title")]
                        row["matches"].append({"score": r.get("score", 0), "title": rec.get("title", ""), "artist": artists, "albums": groups[:5]})
                if not row["matches"]:
                    row["why"] = "AcoustID does not know this recording"
            except Exception as e:
                row["why"] = "fingerprint failed: %s" % e
    out.append(row)
print("RESULT " + json.dumps(out))
'''


def run_in_beets(script, payload, timeout):
    """Runs a script with the interpreter of the beets container, the payload as JSON on stdin. Takes no lock: the caller
    holds the library lock when it needs one. Returns the CompletedProcess."""
    return subprocess.run(
        config.DOCKER + ["exec", "-i", config.BEETS, "sh", "-c", LAUNCH, script],
        input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )


def result_line(text):
    """The JSON after the last 'RESULT ' line of a script's output, or None."""
    result = None
    for line in text.splitlines():
        if line.startswith("RESULT "):
            try:
                result = json.loads(line[7:])
            except ValueError:
                pass
    return result


def do_edit(payload, script=None, what="edit"):
    """Runs an edit script in the beets container with the payload as JSON on stdin. Returns (status, body)."""
    script = script or EDIT_PY
    try:
        with beets_lock(10):
            try:
                p = run_in_beets(script, payload, config.EDIT_TIMEOUT)
            except subprocess.TimeoutExpired:
                return 504, {"error": "The %s took too long and was stopped. Some files may have changed; try again." % what}
            except OSError as e:
                return 503, {"error": "Cannot run docker: %s" % e}
    except TimeoutError as e:
        return 503, {"error": "Cannot %s right now: %s. Try again when it finishes." % (what, e)}
    text = p.stdout + p.stderr
    append_file(os.path.join(config.APPDATA, "tag-edits.log"), "=== %s ===\n%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), text))
    result = result_line(text)
    if result is None:
        return 500, {"error": "The %s failed: " % what + (text.strip().splitlines() or ["no output"])[-1][:300]}
    if p.returncode != 0 or result.get("failed"):
        return 500, {"error": "Could not write %d %s: %s" % (result.get("failed", 0), "folder(s)" if script is COVER_PY else "file(s)", text.strip()[-400:])}
    return 200, {"written": result.get("written", 0), "embedded": result.get("embedded", 0), "shadowed": result.get("shadowed", []), "skipped": result.get("skipped", []), "missing": result.get("missing", []), "log": text[-2000:]}


def do_delete(groups):
    """Deletes duplicate copies (see DELETE_PY). Returns (status, body) with one result per copy, in order."""
    try:
        with beets_lock(10):
            try:
                p = run_in_beets(DELETE_PY, groups, config.EDIT_TIMEOUT)
            except subprocess.TimeoutExpired:
                return 504, {"error": "The delete took too long and was stopped. Some files may have gone; look again."}
            except OSError as e:
                return 503, {"error": "Cannot run docker: %s" % e}
    except TimeoutError as e:
        return 503, {"error": "Cannot delete right now: %s. Try again when it finishes." % e}
    text = p.stdout + p.stderr
    append_file(os.path.join(config.APPDATA, "tag-edits.log"), "=== %s delete duplicates ===\n%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), text))
    result = result_line(text)
    if not isinstance(result, list):
        return 500, {"error": "The delete failed: " + (text.strip().splitlines() or ["no output"])[-1][:300]}
    return 200, {"results": result}


def do_fingerprint(songs):
    """Fingerprints up to 5 songs (matched by names, like edits) and looks them up on AcoustID. Returns (status, body)."""
    try:
        p = run_in_beets(FINGERPRINT_PY, songs, config.EDIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return 504, {"error": "The fingerprint lookup took too long."}
    except OSError as e:
        return 503, {"error": "Cannot run docker: %s" % e}
    result = result_line(p.stdout + p.stderr)
    if not isinstance(result, list):
        return 500, {"error": "The fingerprint lookup failed: " + ((p.stdout + p.stderr).strip().splitlines() or ["no output"])[-1][:300]}
    return 200, {"results": result}
