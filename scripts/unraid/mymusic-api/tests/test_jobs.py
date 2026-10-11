"""Which jobs may overlap, how the enrich is chunked, and that the enrich never blocks the next import batch."""
import os
import sys
import threading
import unittest

os.environ.setdefault("AGENT_KEY", "test-key")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import config  # noqa: E402
import locks  # noqa: E402
from jobs.enrich import chunked, id_ranges  # noqa: E402
from watcher import Enricher  # noqa: E402


class Slots(unittest.TestCase):
    def setUp(self):
        locks.active.clear()

    tearDown = setUp

    def test_import_and_enrich_run_side_by_side(self):
        locks.active["a"] = "enrich"
        self.assertIsNone(locks._why_blocked("import"))
        locks.active["b"] = "import"
        self.assertIsNone(locks._why_blocked("youtube"))

    def test_one_of_each_kind(self):
        locks.active["a"] = "enrich"
        self.assertIn("enrich", locks._why_blocked("enrich"))
        locks.active["b"] = "import"
        self.assertIn("import", locks._why_blocked("import"))

    def test_youtube_is_capped(self):
        for i in range(config.MAX_YT):
            self.assertIsNone(locks._why_blocked("youtube"))
            locks.active["y%d" % i] = "youtube"
        self.assertIn("YouTube", locks._why_blocked("youtube"))


class Chunks(unittest.TestCase):
    def test_ranges(self):
        self.assertEqual(id_ranges([5, 1, 2, 9, 3], 2), [(1, 2), (3, 5), (9, 9)])
        self.assertEqual(id_ranges([]), [])

    def test_commands(self):
        self.assertEqual(chunked(["beet", "fetchart"], [1, 2, 3], ), [["beet", "fetchart", "id:1..3"]])
        self.assertEqual(chunked(["beet", "fetchart"], None), [["beet", "fetchart"]])
        self.assertEqual(chunked(["beet", "fetchart"], []), [])


class EnricherRequests(unittest.TestCase):
    def test_a_request_during_a_run_makes_one_more_run(self):
        started, release, runs = threading.Event(), threading.Event(), []

        def run(kind, run_id, payload, make_id):
            runs.append(kind)
            started.set()
            release.wait(5)

        e = Enricher(run=run, make_id=None)
        threading.Thread(target=e.loop, daemon=True).start()
        e.request()
        self.assertTrue(started.wait(5))
        e.request()
        e.request()  # several requests while running count as one more run
        release.set()
        for _ in range(100):
            if len(runs) == 2:
                break
            threading.Event().wait(0.05)
        self.assertEqual(runs, ["enrich", "enrich"])


if __name__ == "__main__":
    unittest.main()
