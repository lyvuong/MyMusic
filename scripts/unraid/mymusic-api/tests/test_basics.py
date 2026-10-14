"""Pure-function checks for the home API. Run: python -m unittest discover -s scripts/unraid/mymusic-api/tests"""
import os
import sys
import unittest

os.environ.setdefault("AGENT_KEY", "test-key")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import config  # noqa: E402
from jobs import JOBS  # noqa: E402
from jobs.youtube import ai_label_in, clean_tag, clean_url, tidy_title  # noqa: E402


class CleanUrl(unittest.TestCase):
    def test_accepts_single_videos(self):
        for url in ("https://youtu.be/abc123", "https://www.youtube.com/watch?v=abc123", "https://youtube.com/shorts/abc123"):
            self.assertEqual(clean_url(url), url)

    def test_rejects_everything_else(self):
        for url in ("http://youtu.be/abc123", "https://youtube.com/playlist?list=x", "https://evil.example/watch?v=1",
                    "https://youtu.be/abc 123", "https://user:pw@youtu.be/abc", None, 5):
            self.assertIsNone(clean_url(url), url)


class RunId(unittest.TestCase):
    def test_run_id_shape(self):
        self.assertTrue(config.RUN_ID_RE.match("abc-123_X"))
        self.assertFalse(config.RUN_ID_RE.match("../etc"))
        self.assertFalse(config.RUN_ID_RE.match(""))


class Tags(unittest.TestCase):
    def test_clean_tag_strips_control_chars_and_limits(self):
        self.assertEqual(clean_tag("  a\x00b \n c "), "ab c")
        self.assertEqual(len(clean_tag("x" * 500)), 200)

    def test_tidy_title(self):
        self.assertEqual(tidy_title("Song (Official Video)"), "Song")
        self.assertEqual(tidy_title("Artist - Song", "Artist"), "Song")

    def test_ai_label(self):
        self.assertFalse(ai_label_in("<html></html>"))
        self.assertTrue(ai_label_in('..."howThisWasMadeSectionViewModel":{"x":"Altered or synthetic content"}'))


class Jobs(unittest.TestCase):
    def test_registry(self):
        self.assertEqual(sorted(JOBS), ["enrich", "import", "youtube"])


class NightlyAlbums(unittest.TestCase):
    def test_stops_when_nothing_is_left(self):
        from albums import run_once
        answers = [{"checked": 5, "saved": 3, "applied": 1, "remaining": 7}, {"checked": 2, "saved": 0, "applied": 0, "remaining": 0}]
        calls = []
        r = run_once(post=lambda path, q=None, timeout=0: (calls.append(path), answers.pop(0))[1], cap=100)
        self.assertEqual(r, {"checked": 7, "saved": 3, "applied": 1})
        self.assertEqual(len(calls), 2)

    def test_stops_at_the_nightly_cap(self):
        from albums import run_once
        r = run_once(post=lambda path, q=None, timeout=0: {"checked": 5, "saved": 1, "applied": 0, "remaining": 99}, cap=10)
        self.assertEqual(r["checked"], 10)

    def test_unreachable_worker(self):
        from albums import run_once
        self.assertIsNone(run_once(post=lambda path, q=None, timeout=0: None, cap=10))


if __name__ == "__main__":
    unittest.main()


class NightlyMixes(unittest.TestCase):
    def test_seconds_until_wraps_past_midnight(self):
        import time
        from mixes import seconds_until
        at = lambda h, m=0: time.struct_time((2026, 1, 1, h, m, 0, 0, 1, -1))
        self.assertEqual(seconds_until(3, at(1)), 2 * 3600)
        self.assertEqual(seconds_until(3, at(3)), 86400)
        self.assertEqual(seconds_until(3, at(23, 30)), 3 * 3600 + 1800)

    def test_run_once_pages_until_a_short_slice(self):
        from mixes import run_once
        calls = []
        answers = [{"members": 2, "mixes": 8}, {"members": 2, "mixes": 4}, {"members": 1, "mixes": 4}]

        def post(path, query):
            calls.append((path, query))
            return answers[len(calls) - 1]

        self.assertEqual(run_once(post, batch=2), 16)
        self.assertEqual([q["offset"] for _, q in calls], ["0", "2", "4"])

    def test_run_once_reports_an_unreachable_worker(self):
        from mixes import run_once
        self.assertIsNone(run_once(lambda p, q: None, batch=2))
