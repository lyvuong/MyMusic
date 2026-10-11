"""The Organize button and the inbox watcher's batches: import what is in the inbox into the Beets library.

Every run works on a snapshot: the entries it takes (loose files and folders) are moved into `_inbox/_staging/<run id>`
first, so files copied in while it runs are neither picked up half-written nor miscounted. After the import, songs
Beets skipped as duplicates are deleted when they are confirmed to be the same song (same names, same length); anything
else that was left behind is moved to `_inbox/_skipped/<run id>` so it cannot trigger the same run again and again.
"""
import os
import re
import subprocess
import tempfile

import config
from edit import CONFIRM_PY, result_line, run_in_beets
from locks import beets_lock
from reporting import report, worker_post
from util import append_file, log

# Folders of the inbox that belong to the server, never to an import batch.
SPECIAL = ("_youtube", "_staging", "_skipped")
PARTIAL = (".part", ".partial", ".tmp", ".crdownload")
AUDIO = (".mp3", ".flac", ".m4a", ".mp4", ".ogg", ".oga", ".opus", ".wav", ".aac", ".wma", ".aiff", ".aif", ".ape", ".wv", ".alac")
DELETE_CHUNK = 100


def is_special(name):
    """True for names the importer must leave alone: the server's own folders, hidden files and unfinished downloads."""
    return name in SPECIAL or name.startswith(".") or name.lower().endswith(PARTIAL)


def inbox_entries():
    try:
        return sorted(n for n in os.listdir(config.INBOX) if not is_special(n))
    except OSError:
        return []


def count_files(path):
    if os.path.isfile(path):
        return 1
    return sum(len(files) for _, _, files in os.walk(path))


def count_inbox():
    """Files waiting in the inbox (the server's own folders are not counted)."""
    return sum(count_files(os.path.join(config.INBOX, n)) for n in inbox_entries())


def parse_duplicate_skips(text):
    """Paths Beets logged as skipped because they duplicate a song or album already in the library.
    Log lines look like `duplicate-skip /downloads/_staging/x/Album`; several paths are joined with '; '."""
    paths = []
    for line in text.splitlines():
        if line.startswith("duplicate-skip "):
            paths += [p.strip() for p in re.split(r";\s+(?=/)", line[len("duplicate-skip "):]) if p.strip()]
    return paths


def under(path, roots):
    """True when path is one of the roots or lies inside one."""
    return any(path == r or path.startswith(r.rstrip("/") + "/") for r in roots)


def staged_audio(stage_api, stage_box):
    """The audio files still in the staging folder, as paths inside the beets container."""
    found = []
    for root, _, files in os.walk(stage_api):
        for f in files:
            if f.lower().endswith(AUDIO):
                rel = os.path.relpath(os.path.join(root, f), stage_api).replace(os.sep, "/")
                found.append(stage_box + "/" + rel)
    return sorted(found)


def beets_exec(*args, timeout=300):
    return subprocess.run(config.DOCKER + ["exec", config.BEETS] + list(args), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)


def stage(run_id, entries):
    """Moves the entries into this run's staging folder (a rename on the same share). Returns a log line."""
    dest = "/downloads/_staging/%s" % run_id
    r = beets_exec("mkdir", "-p", dest)
    if r.returncode:
        raise RuntimeError("cannot create the staging folder: %s" % r.stderr.strip()[-200:])
    r = beets_exec("mv", "--", *["/downloads/" + e for e in entries], dest + "/")
    if r.returncode:
        return "Some entries could not be moved to staging: %s\n" % r.stderr.strip()[-300:]
    return ""


def unstage(run_id):
    """Puts a staged batch back into the inbox (the run could not start)."""
    beets_exec("sh", "-c", 'mv -n "$0"/* /downloads/ 2>/dev/null; rmdir "$0" 2>/dev/null; true', "/downloads/_staging/%s" % run_id)


def park(run_id, stage_api, stage_box, out):
    """Prunes empty folders; moves what is left in the staging folder to _skipped, or removes the empty staging folder.
    Returns how many files were left behind."""
    beets_exec("find", stage_box, "-mindepth", "1", "-type", "d", "-empty", "-delete")
    left = count_files(stage_api) if os.path.isdir(stage_api) else 0
    if left:
        beets_exec("mkdir", "-p", "/downloads/_skipped")
        beets_exec("mv", "--", stage_box, "/downloads/_skipped/" + run_id)
        out.append("%d file(s) were not imported; they are in _inbox/_skipped/%s\n" % (left, run_id))
    elif os.path.isdir(stage_api):
        beets_exec("rmdir", stage_box)
    return left


def settle(run_id, stage_api, stage_box, dup_log, out):
    """After the passes: delete confirmed duplicates, then move whatever is left out of the way.
    Returns how many files were left behind (not imported)."""
    skipped = parse_duplicate_skips(dup_log)
    audio = [p for p in staged_audio(stage_api, stage_box) if under(p, skipped)]
    if audio:
        verdict = None
        try:
            r = run_in_beets(CONFIRM_PY, audio, 300)
            verdict = result_line(r.stdout + r.stderr)
        except (subprocess.SubprocessError, OSError) as e:
            out.append("Could not check the duplicates (%s).\n" % e)
        if verdict is None:
            out.append("Duplicates were not checked, so nothing was deleted.\n")
        else:
            gone = [v["path"] for v in verdict if v.get("dup") and under(v["path"], [stage_box])]
            for i in range(0, len(gone), DELETE_CHUNK):
                beets_exec("rm", "-f", "--", *gone[i:i + DELETE_CHUNK])
            for v in verdict:
                name = os.path.basename(v["path"])
                if v.get("dup") and v["path"] in gone:
                    out.append("Removed duplicate: %s\n" % name)
                else:
                    out.append("Kept (not confirmed as a duplicate): %s - %s\n" % (name, v.get("why", "")))
            out.append("Duplicates: %d removed, %d kept.\n" % (len(gone), len(verdict) - len(gone)))
    return park(run_id, stage_api, stage_box, out)


def run_import(run_id, payload=None):
    """The Organize button and the watcher's batches. Pass 1 groups files into albums by their tags, pass 2 imports
    leftovers one by one. Only musicbrainz, scrub and fromfilename load, so it is fast; enrich adds art and genres.
    `payload["entries"]` limits the run to those inbox entries (the watcher); without it everything waiting is taken."""
    stage_api = os.path.join(config.INBOX, "_staging", run_id)
    stage_box = "/downloads/_staging/%s" % run_id
    out = []
    exit_code = 0
    before = after = 0
    staged = False
    try:
        wanted = (payload or {}).get("entries")
        entries = [e for e in (wanted if wanted is not None else inbox_entries())
                   if not is_special(e) and os.path.lexists(os.path.join(config.INBOX, e))]
        if entries:
            note = stage(run_id, entries)
            staged = True
            if note:
                out.append(note)
        before = count_files(stage_api) if staged else 0
        log("import %s: %d file(s) in %d entr%s" % (run_id, before, len(entries), "y" if len(entries) == 1 else "ies"))
        if not worker_post("/api/beets/agent/progress", {"id": run_id, "before": before, "now": before}):
            log("import %s: the Worker did not accept progress; the web app will show no progress bar" % run_id)
        dup_log = ""
        if staged:
            with beets_lock(3600):
                for i, flag in enumerate(("-g", "-s")):
                    if i == 1:
                        out.append("--- second pass: leftovers as single tracks ---\n")
                    box_log = "/config/import-%s-%d.log" % (run_id, i)
                    with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False) as tmp:
                        proc = subprocess.Popen(
                            config.DOCKER + ["exec", config.BEETS, "beet", "-p", "musicbrainz,scrub,fromfilename", "import", flag, "-q",
                                             "-l", box_log, stage_box],
                            stdout=tmp, stderr=subprocess.STDOUT,
                        )
                        while True:
                            try:
                                proc.wait(timeout=10)
                                break
                            except subprocess.TimeoutExpired:
                                worker_post("/api/beets/agent/progress", {"id": run_id, "before": before, "now": count_files(stage_api)})
                    with open(tmp.name, encoding="utf-8", errors="replace") as fh:
                        out.append(fh.read())
                    os.unlink(tmp.name)
                    if proc.returncode:
                        exit_code = proc.returncode
                    skip_log = os.path.join(config.APPDATA, "import-%s-%d.log" % (run_id, i))
                    try:
                        with open(skip_log, encoding="utf-8", errors="replace") as fh:
                            text = fh.read()
                        dup_log += text
                        append_file(os.path.join(config.APPDATA, "skipped.log"), text)
                        os.unlink(skip_log)
                    except OSError:
                        pass
                after = settle(run_id, stage_api, stage_box, dup_log, out)
    except TimeoutError as e:
        out.append("Gave up: %s\n" % e)
        exit_code = 1
        if staged:
            unstage(run_id)
    except Exception as e:  # keep the report path alive whatever happens
        out.append("Import failed: %s\n" % e)
        exit_code = 1
        if staged:
            try:
                after = park(run_id, stage_api, stage_box, out)
            except Exception as e2:
                out.append("Could not move the staged files out of the way: %s\n" % e2)
    text = "".join(out)
    append_file(os.path.join(config.APPDATA, "auto-import.log"), text)
    report(run_id, exit_code == 0, exit_code, text or "(no output: nothing to import)", before, after)


def recover_staging():
    """At startup: a batch whose run died with the previous process is still in _staging. Put it back in the inbox so
    the next run takes it."""
    root = os.path.join(config.INBOX, "_staging")
    try:
        runs = sorted(os.listdir(root))
    except OSError:
        return
    for run_id in runs:
        log("recovering the staged files of run %s" % run_id)
        try:
            unstage(run_id)
        except (subprocess.SubprocessError, OSError) as e:
            log("could not recover %s: %s" % (run_id, e))
