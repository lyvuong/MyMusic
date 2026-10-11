"""Small helpers shared by every module."""
import sys
import time


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, file=sys.stderr, flush=True)


def append_file(path, text):
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)
    except OSError as e:
        log("cannot write %s: %s" % (path, e))
