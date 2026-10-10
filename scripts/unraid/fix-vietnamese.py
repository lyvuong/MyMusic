"""Turns ASCII-typed Vietnamese (VIQR style) in Beets tags into real Vietnamese.

Runs inside the Beets container. Without --apply it only prints what it would change.

    docker exec -i beets /lsiopy/bin/python3 - < fix-vietnamese.py            # preview
    docker exec -i beets /lsiopy/bin/python3 - --apply < fix-vietnamese.py    # do it

A word like Tri.nh or Ba.n (a dot or tilde after a vowel, then lowercase letters) also counts as Vietnamese.

Decodes   o* o+ -> ơ   u* u+ -> ư   a( -> ă   a^ e^ o^ -> â ê ô   dd d- -> đ
and the tones   `  ->  grave   '  ->  acute   ?  ->  hook   ~  ->  tilde   .  ->  dot below
so  "Hu+o+*ng Ca^`n"  becomes  "Hương Cần".  "_20" (an encoded space) becomes a space everywhere.

The first letter of every word in a Vietnamese field (decoded here or already real Vietnamese) is capitalised: "hương cần" -> "Hương Cần".

A field is only decoded when it clearly contains Vietnamese markers (a^ o* u+ a` or a word starting dd/d-), so English
titles are left alone. File names cannot hold ' ( ? so those marks were replaced by "_" and are lost: such fields are
decoded as far as possible and listed in /config/vietnamese-review.txt to be finished by hand (Mp3tag).

--apostrophes  also turns "_" back into an apostrophe in English titles ("Let_s Hang On" -> "Let's Hang On").
"""
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict

APPLY = "--apply" in sys.argv
APOSTROPHES = "--apostrophes" in sys.argv

MARKS = {"(": ("̆", "aA"), "^": ("̂", "aAeEoO"), "+": ("̛", "oOuU"), "*": ("̛", "oOuU")}
TONES = {"`": "̀", "'": "́", "?": "̉", "~": "̃", ".": "̣"}
HEX = {"20": " ", "27": "'", "28": "(", "29": ")", "2C": ",", "2D": "-"}

HEX_RE = re.compile(r"_([0-9A-F]{2})")
SYLLABLE = re.compile(r"([aeiouyAEIOUY])([(^+*])?([`'?~.])?")
D_MARK = re.compile(r"(?<![A-Za-z])([dD])([dD-])(?=[aeiouyAEIOUY])")
STRONG = re.compile(
    r"[aAeEoO]\^|[oOuU][+*]|[aeiouyAEIOUY]`|(?<![A-Za-z])[dD][dD-](?=[aeiouyAEIOUY])"
    r"|(?<=[A-Za-z])[aeiouyAEIOUY][.~][a-z]+(?!\.)"  # "Tri.nh", "Ba.n": a lone tone mark inside a lowercase word
)
VIETNAMESE = re.compile("[đĐ̛̣̀́̂̃̆̉]")  # in NFD: d-stroke, tones, breve, circumflex, horn
APOSTROPHE = re.compile(r"(?<=[A-Za-z])_(?=(?:s|t|m|d|re|ve|ll)\b)")


def _accent(m):
    v, mark, tone = m.groups()
    if mark and v not in MARKS[mark][1]:
        return m.group(0)
    tail = ""
    if tone in (".", "?") and not (m.end() < len(m.string) and m.string[m.end()].isalpha()):
        tail, tone = tone, None  # a dot or question mark ending a word is punctuation
    if not mark and not tone:
        return v + tail
    out = v + (MARKS[mark][0] if mark else "") + (TONES[tone] if tone else "")
    return unicodedata.normalize("NFC", out) + tail


WORD_START = re.compile(r"(^|[\s(\[\"])(\w)")


def _capitalise(s):
    return WORD_START.sub(lambda m: m.group(1) + m.group(2).upper(), s)


def decode(text, apostrophes=False):
    """Returns (decoded text, True when it is Vietnamese that still has a lost mark ("_"))."""
    s = HEX_RE.sub(lambda m: HEX.get(m.group(1), m.group(0)), text)
    if STRONG.search(s):
        s = D_MARK.sub(lambda m: "Đ" if m.group(1) == "D" else "đ", s)
        s = SYLLABLE.sub(_accent, s)
        return _capitalise(s), "_" in s
    if apostrophes:
        s = APOSTROPHE.sub("'", s)
    if VIETNAMESE.search(unicodedata.normalize("NFD", s)):
        s = _capitalise(s)
    return s, False


def beet(*args):
    return subprocess.run(["beet", *args], capture_output=True, text=True)


def main():
    if subprocess.run(["pgrep", "-f", "beet import"], capture_output=True).returncode == 0:
        sys.exit("A Beets import is running. Wait for it to finish, then run this again.")

    sep = "\x1f"
    fields = ("id", "title", "artist", "album", "albumartist")
    rows = [l.split(sep) for l in beet("ls", "-f", sep.join("$" + f for f in fields)).stdout.splitlines()]
    titles, shared, review = [], {"artist": {}, "album": {}, "albumartist": {}}, []

    for row in rows:
        if len(row) != len(fields):
            continue
        item = dict(zip(fields, row))
        for field in ("title", "artist", "album", "albumartist"):
            old = item[field]
            if not old:
                continue
            new, unresolved = decode(old, APOSTROPHES)
            if unresolved:
                review.append(f"{item['id']}\t{field}\t{new}")
            if new == old:
                continue
            if field == "title":
                titles.append((item["id"], old, new))
            else:
                shared[field][old] = new

    changes = [("title", old, new) for _, old, new in titles] + [(f, o, n) for f, d in shared.items() for o, n in d.items()]
    for field, old, new in changes[:80]:
        print(f"{field}: {old}  ->  {new}")
    if len(changes) > 80:
        print(f"... and {len(changes) - 80} more")
    print(f"\n{len(titles)} titles and {sum(len(d) for d in shared.values())} artist/album names to change.")

    if review:
        with open("/config/vietnamese-review.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(review) + "\n")
        print(f"{len(review)} fields still have a lost accent mark (_): /config/vietnamese-review.txt")

    if not APPLY:
        print("Preview only. Run again with --apply to change the library.")
        return

    for field, pairs in shared.items():
        for old, new in pairs.items():
            r = beet("modify", "-y", *(["-a"] if field != "artist" else []), f"{field}:={old}", f"{field}={new}")
            if r.returncode != 0:
                print("failed:", field, old, (r.stderr or r.stdout).strip()[-200:])
    for n, (item_id, old, new) in enumerate(titles, 1):
        r = beet("modify", "-y", f"id:{item_id}", f"title={new}")
        if r.returncode != 0:
            print("failed:", old, (r.stderr or r.stdout).strip()[-200:])
        if n % 25 == 0:
            print(f"  {n}/{len(titles)} titles")
    print("Done. Press Organize in the web app to rescan Navidrome and sync.")


if __name__ == "__main__":
    main()
