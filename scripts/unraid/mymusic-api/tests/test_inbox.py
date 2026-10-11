"""The inbox watcher's batching and the importer's pure helpers."""
import os
import sys
import threading
import time
import unittest

os.environ.setdefault("AGENT_KEY", "test-key")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from jobs.importer import is_special, parse_duplicate_skips, under  # noqa: E402
from watcher import Inbox, entry_of  # noqa: E402


class Names(unittest.TestCase):
    def test_special_names(self):
        for n in ("_youtube", "_staging", "_skipped", ".DS_Store", "song.mp3.part", "x.CRDOWNLOAD", "a.tmp"):
            self.assertTrue(is_special(n), n)
        for n in ("Album", "song.mp3", "_Underscore Artist"):
            self.assertFalse(is_special(n), n)

    def test_entry_of(self):
        self.assertEqual(entry_of("/inbox/Album/01.mp3", "/inbox"), "Album")
        self.assertEqual(entry_of("/inbox/song.mp3", "/inbox"), "song.mp3")
        self.assertIsNone(entry_of("/inbox/_staging/run1/a.mp3", "/inbox"))
        self.assertIsNone(entry_of("/inbox/_youtube/x/a.mp3", "/inbox"))
        self.assertEqual(entry_of("/inbox/Album/01.mp3.part", "/inbox"), "Album")  # the entry is the folder
        self.assertIsNone(entry_of("/inbox/song.mp3.part", "/inbox"))


class DuplicateLog(unittest.TestCase):
    def test_parse(self):
        text = "skip /d/a\nduplicate-skip /downloads/_staging/r/Album\nduplicate-skip /downloads/_staging/r/x.mp3; /downloads/_staging/r/y.mp3\nasis /d/b\n"
        self.assertEqual(parse_duplicate_skips(text), ["/downloads/_staging/r/Album", "/downloads/_staging/r/x.mp3", "/downloads/_staging/r/y.mp3"])

    def test_parse_keep_tag_and_console_text(self):
        # What this server's Beets really wrote: skipped duplicates are tagged duplicate-keep, and the console says why.
        text = ("asis /downloads/_staging/r/a.mp3\nduplicate-keep /downloads/_staging/r/a.mp3\n"
                "/downloads/_staging/r/b.mp3\nImporting as-is.\nThis track is already in the library!\nSkipping.\n"
                "/downloads/_staging/r/c.mp3\nImporting as-is.\n")
        self.assertEqual(parse_duplicate_skips(text), ["/downloads/_staging/r/a.mp3", "/downloads/_staging/r/b.mp3"])

    def test_under(self):
        roots = ["/s/Album", "/s/x.mp3"]
        self.assertTrue(under("/s/Album/01.mp3", roots))
        self.assertTrue(under("/s/x.mp3", roots))
        self.assertFalse(under("/s/Album2/01.mp3", roots))


class Batching(unittest.TestCase):
    def make(self, present, debounce=0.15):
        self.present = set(present)
        return Inbox(debounce, listing=lambda: sorted(self.present))

    mtime = staticmethod(lambda e: 1.0)

    def test_quiet_entries_go_busy_ones_wait(self):
        inbox = self.make(["a", "b"])
        inbox.touch("a")
        time.sleep(0.2)
        inbox.touch("b")  # b is still being written
        self.assertEqual(inbox.next_batch(self.mtime), ["a"])
        self.present.discard("a")
        t0 = time.monotonic()
        self.assertEqual(inbox.next_batch(self.mtime), ["b"])
        self.assertGreaterEqual(time.monotonic() - t0, 0.05)

    def test_unknown_entries_are_quiet(self):
        inbox = self.make(["x"])
        self.assertEqual(inbox.next_batch(self.mtime), ["x"])

    def test_blocks_until_an_event(self):
        inbox = self.make([])
        got = []
        th = threading.Thread(target=lambda: got.append(inbox.next_batch(self.mtime)))
        th.start()
        time.sleep(0.1)
        self.assertEqual(got, [])
        self.present.add("new")
        inbox.touch("new")
        th.join(2)
        self.assertEqual(got, [["new"]])

    def test_blocked_entry_is_skipped_until_it_changes(self):
        inbox = self.make(["stuck"])
        inbox.block(["stuck"], self.mtime)
        self.assertEqual(inbox.waiting(self.mtime), [])
        self.assertEqual(inbox.waiting(lambda e: 2.0), ["stuck"])


class Settle(unittest.TestCase):
    """settle() against a temporary inbox, with `docker exec beets` replaced by plain file operations."""

    def setUp(self):
        import shutil
        import tempfile
        from types import SimpleNamespace
        import config
        from jobs import importer
        self.importer, self.config = importer, config
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = (config.INBOX, importer.beets_exec, importer.run_in_beets)
        config.INBOX = self.tmp
        self.verdict = []

        def host(p):  # a path inside the beets container -> the same file in the temporary inbox
            return os.path.join(self.tmp, p[len("/downloads/"):]) if p.startswith("/downloads/") else p

        def fake_exec(*args, timeout=300):
            cmd, rest = args[0], [a for a in args[1:] if a != "--"]
            if cmd == "rm":
                for p in rest[1:]:
                    os.unlink(host(p))
            elif cmd == "mkdir":
                os.makedirs(host(rest[-1]), exist_ok=True)
            elif cmd == "mv":
                shutil.move(host(rest[0]), host(rest[1]))
            elif cmd == "rmdir":
                os.rmdir(host(rest[0]))
            elif cmd == "find":  # prune empty folders under the staging folder
                for root, dirs, files in os.walk(host(rest[0]), topdown=False):
                    if root != host(rest[0]) and not os.listdir(root):
                        os.rmdir(root)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        importer.beets_exec = fake_exec
        importer.run_in_beets = lambda script, payload, timeout: SimpleNamespace(
            returncode=0, stderr="", stdout="RESULT " + __import__("json").dumps(
                [{"path": p, "dup": p.endswith(tuple(self.dups)), "why": "test"} for p in payload]))
        self.addCleanup(lambda: (setattr(config, "INBOX", self.saved[0]), setattr(importer, "beets_exec", self.saved[1]),
                                 setattr(importer, "run_in_beets", self.saved[2])))

    def put(self, rel):
        path = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("x")

    def test_confirmed_duplicates_are_deleted_and_the_rest_parked(self):
        self.dups = ("dup.mp3",)
        self.put("_staging/r1/Album/dup.mp3")
        self.put("_staging/r1/Album/remix.mp3")   # logged as a duplicate, but not confirmed
        self.put("_staging/r1/other.mp3")          # skipped for another reason
        out = []
        log = "duplicate-skip /downloads/_staging/r1/Album\nskip /downloads/_staging/r1/other.mp3\n"
        left = self.importer.settle("r1", os.path.join(self.tmp, "_staging", "r1"), "/downloads/_staging/r1", log, out)
        self.assertEqual(left, 2)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "_staging", "r1")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "_skipped", "r1", "Album", "dup.mp3")))
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "_skipped", "r1", "Album", "remix.mp3")))
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "_skipped", "r1", "other.mp3")))
        text = "".join(out)
        self.assertIn("Removed duplicate: dup.mp3", text)
        self.assertIn("Kept (not confirmed as a duplicate): remix.mp3", text)

    def test_run_import_stages_only_its_entries(self):
        """A whole run: the entries it was given are staged, imported and cleaned up; a file that arrived meanwhile stays."""
        from contextlib import nullcontext
        from types import SimpleNamespace
        importer, config = self.importer, self.config
        self.dups = ()
        self.put("Album/01.mp3")
        self.put("late.mp3")  # not in the batch: copied in while the run was going
        appdata = os.path.join(self.tmp, "appdata")
        os.makedirs(appdata)
        reports = []
        saved = (importer.subprocess.Popen, importer.beets_lock, importer.report, importer.worker_post, config.APPDATA)
        fake_exec = importer.beets_exec

        class FakeProc:
            returncode = 0

            def __init__(self, cmd, stdout=None, stderr=None):
                self.cmd = cmd
                # beets moves the imported file out of the staging folder
                staged = os.path.join(config_inbox(), "_staging", "r3", "Album", "01.mp3")
                if os.path.exists(staged):
                    os.unlink(staged)
                stdout.write("imported\n")

            def wait(self, timeout=None):
                return 0

        def config_inbox():
            return self.tmp

        importer.subprocess = SimpleNamespace(Popen=FakeProc, STDOUT=-2, TimeoutExpired=TimeoutError, SubprocessError=Exception, run=None)
        importer.beets_lock = lambda wait: nullcontext()
        importer.report = lambda *a, **k: reports.append(a)
        importer.worker_post = lambda *a, **k: True
        config.APPDATA = appdata
        importer.beets_exec = fake_exec
        try:
            importer.run_import("r3", {"entries": ["Album"]})
        finally:
            importer.subprocess = __import__("subprocess")
            importer.beets_lock, importer.report, importer.worker_post, config.APPDATA = saved[1:]
        self.assertEqual(len(reports), 1)
        run_id, ok, exit_code, text, before, after = reports[0]
        self.assertEqual((run_id, ok, exit_code, before, after), ("r3", True, 0, 1, 0), text)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "late.mp3")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "_staging", "r3")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "Album")))

    def test_nothing_left_removes_the_staging_folder(self):
        self.dups = ("a.mp3",)
        self.put("_staging/r2/a.mp3")
        left = self.importer.settle("r2", os.path.join(self.tmp, "_staging", "r2"), "/downloads/_staging/r2",
                                    "duplicate-skip /downloads/_staging/r2/a.mp3\n", [])
        self.assertEqual(left, 0)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "_staging", "r2")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "_skipped")))


if __name__ == "__main__":
    unittest.main()
