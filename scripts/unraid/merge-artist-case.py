"""Merges artists whose names differ only by capitalisation ("Berlin Orchestra" / "Berlin orchestra").

Runs inside the Beets container. Without --apply it only prints what it would change.

    docker exec -i beets python3 - < merge-artist-case.py            # preview
    docker exec -i beets python3 - --apply < merge-artist-case.py    # do it

The most-used spelling wins (ties go to the one with more capital letters). Beets then retags the other
spellings and moves the files into the winning folder. Run `beet update` afterwards if you edited tags elsewhere.
"""
import subprocess
import sys
from collections import Counter, defaultdict

APPLY = "--apply" in sys.argv


def beet(*args):
    return subprocess.run(["beet", *args], capture_output=True, text=True)


if subprocess.run(["pgrep", "-f", "beet import"], capture_output=True).returncode == 0:
    sys.exit("A Beets import is running. Wait for it to finish, then run this again.")

merged = 0
for field, albums in (("albumartist", True), ("artist", False)):
    out = beet("ls", *(["-a"] if albums else []), "-f", "$" + field).stdout.splitlines()
    counts = Counter(line for line in out if line.strip())
    by_fold = defaultdict(list)
    for name, n in counts.items():
        by_fold[name.casefold()].append((n, name))
    for variants in by_fold.values():
        if len(variants) < 2:
            continue
        keep = max(variants, key=lambda v: (v[0], sum(c.isupper() for c in v[1])))[1]
        others = sorted(name for _, name in variants if name != keep)
        print(f'{field}: keep "{keep}", change {", ".join(repr(o) for o in others)}')
        merged += 1
        if not APPLY:
            continue
        for other in others:
            r = beet("modify", "-y", *(["-a"] if albums else []), f"{field}:={other}", f"{field}={keep}")
            if r.returncode != 0:
                print("  failed:", (r.stderr or r.stdout).strip()[-300:])

if merged == 0:
    print("No artists differ only by capitalisation.")
elif not APPLY:
    print(f"\n{merged} to merge. Run again with --apply to do it.")
else:
    print(f"\nMerged {merged}. Press Organize in the web app to rescan Navidrome and sync.")
