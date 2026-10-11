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


if __name__ == "__main__":
    unittest.main()
