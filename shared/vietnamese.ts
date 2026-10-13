/**
 * Cleaning up Vietnamese names (titles, albums, artists), shared by the web app and the Worker.
 * Three problems are handled:
 *  - names typed in ASCII (VIQR style: "Hu+o+*ng Ca^`n" -> "Hương Cần"), the same rules as scripts/unraid/fix-vietnamese.py
 *  - names written without accents ("Con Yeu Em Mai"), which only a language model can restore (see worker/vietnamese.ts)
 *  - capitalisation and spacing ("CON YÊU EM MÃI", "còn  yêu em mãi")
 */

const MARKS: Record<string, [string, string]> = {
  "(": ["̆", "aA"],
  "^": ["̂", "aAeEoO"],
  "+": ["̛", "oOuU"],
  "*": ["̛", "oOuU"],
};
const TONES: Record<string, string> = { "`": "̀", "'": "́", "?": "̉", "~": "̃", ".": "̣" };
const HEX: Record<string, string> = { "20": " ", "27": "'", "28": "(", "29": ")", "2C": ",", "2D": "-" };

const HEX_RE = /_([0-9A-F]{2})/g;
const SYLLABLE = /([aeiouyAEIOUY])([(^+*])?([`'?~.])?/g;
const D_MARK = /(?<![A-Za-z])([dD])([dD-])(?=[aeiouyAEIOUY])/g;
// A name is only decoded when it clearly holds typed Vietnamese, so English titles stay as they are.
const STRONG = /[aAeEoO]\^|[oOuU][+*]|[aeiouyAEIOUY]`|(?<![A-Za-z])[dD][dD-](?=[aeiouyAEIOUY])|(?<=[A-Za-z])[aeiouyAEIOUY][.~][a-z]+(?!\.)/;
const VIET_CHARS = /[đĐ̀-̛̣̆̂̉̃]/;
const WORD_START = /(^|[\s(["])(\p{L})/gu;

/** True when the text holds a Vietnamese letter (đ, or a letter with a tone or hat). */
export const hasVietnamese = (s: string): boolean => VIET_CHARS.test(s.normalize("NFD"));

/** Lowercase, no diacritics (đ -> d), single spaces: the comparison form used to check that only marks were added. */
export const fold = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();

const capitalise = (s: string): string => s.replace(WORD_START, (_m, pre: string, ch: string) => pre + ch.toUpperCase());

/** ASCII-typed Vietnamese to real Vietnamese. Returns the text unchanged when it does not clearly contain typed marks. */
export function decodeTyped(text: string): string {
  let s = text.replace(HEX_RE, (m, h: string) => HEX[h] ?? m);
  if (!STRONG.test(s)) return text;
  s = s.replace(D_MARK, (_m, d: string) => (d === "D" ? "Đ" : "đ"));
  s = s.replace(SYLLABLE, (m: string, v: string, mark: string | undefined, tone: string | undefined, offset: number, whole: string) => {
    if (mark && !MARKS[mark]![1].includes(v)) return m;
    let tail = "";
    let t = tone;
    const next = whole[offset + m.length];
    // A dot or question mark that ends a word is punctuation, not a tone mark.
    if ((t === "." || t === "?") && !(next !== undefined && /\p{L}/u.test(next))) {
      tail = t;
      t = undefined;
    }
    if (!mark && !t) return v + tail;
    return (v + (mark ? MARKS[mark]![0] : "") + (t ? TONES[t]! : "")).normalize("NFC") + tail;
  });
  return s;
}

export type FixReason = "typed" | "case";

/**
 * The deterministic clean-up of one name: typed marks decoded, then, for Vietnamese text, spacing normalised and every
 * word capitalised (ALL CAPS and all lowercase become Title Case). Returns null when nothing needs to change.
 */
export function cleanVietnamese(text: string): { text: string; reason: FixReason } | null {
  const decoded = decodeTyped(text);
  const typed = decoded !== text;
  let s = decoded.normalize("NFC").replace(/\s+/g, " ").trim();
  if (hasVietnamese(s)) {
    const letters = s.replace(/[^\p{L}]/gu, "");
    if (letters.length >= 3 && letters === letters.toUpperCase()) s = s.toLowerCase();
    s = capitalise(s);
  }
  if (s === text) return null;
  return { text: s, reason: typed ? "typed" : "case" };
}

// Vietnamese syllables: optional onset, vowels, optional ending. Only a cheap filter for what is worth asking the AI.
// Short English words that also happen to fit the syllable shape.
const ENGLISH = new Set(["the", "you", "let", "my", "is", "are", "was", "to", "of", "in", "on", "for", "all", "and", "with", "when", "this", "that", "love", "be", "it", "we", "she", "me", "he", "no", "so", "do", "go", "up", "man", "can", "hot", "sun", "moon", "day", "boy", "girl", "baby", "one", "two", "not", "but", "out", "now", "new", "old", "big", "red", "see", "say", "way", "her", "his", "him", "our", "your", "them", "they", "there", "here", "come", "get", "got", "put", "run", "live", "life", "time", "feel", "dont", "cant", "wont"]);

/** The words of the library that are written with accents, folded: evidence that an unaccented word is Vietnamese. */
export function accentVocab(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    if (!n || !hasVietnamese(n)) continue;
    for (const w of fold(n).split(/[^a-z]+/)) if (w.length >= 2) out.add(w);
  }
  return out;
}

/** An unaccented word that is a possible Vietnamese syllable (one vowel group from the real list, a real ending). */
function plainSyllable(w: string): boolean {
  const m = SYLLABLE_SHAPE.exec(w);
  return !!m && m[1] !== "oo" && PLAIN_NUCLEI.has(m[1]!);
}

/**
 * True when an unaccented name could be Vietnamese: plain ASCII letters whose words all are possible Vietnamese
 * syllables (no f, j, w, z, no common English words). `contextIsVietnamese` is set when the artist or album already has
 * real Vietnamese letters, which allows a single word. With `vocab` (see accentVocab) a name with no artist context
 * must also be mostly made of words the library already writes with accents, so English titles are not listed.
 */
export function maybeNeedsAccents(text: string, contextIsVietnamese = false, vocab?: Set<string>): boolean {
  if (hasVietnamese(text)) return false;
  if (!/^[A-Za-z0-9\s'"(),.&!?-]+$/.test(text)) return false;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0 || !words.some((w) => w.length >= 2)) return false;
  if (!words.every((w) => !ENGLISH.has(w) && !/[fjwz]/.test(w) && plainSyllable(w))) return false;
  if (contextIsVietnamese) return true;
  if (words.length < 2) return false;
  if (vocab && vocab.size >= 200) return words.filter((w) => vocab.has(w)).length / words.length >= 0.6;
  return true;
}

// What a real Vietnamese syllable is made of (tone marks aside): onset + vowel group + ending.
const ONSET = "(?:ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|[bcdđghklmnpqrstvx])?";
const NUCLEI = new Set(
  ("a ă â e ê i o ô ơ u ư y ai ao au ay âu ây eo êu ia iê iu oa oă oe oi ôi ơi ua uâ uê uô uơ ui uy ưa ưi ưu ươ yê oo ya " +
    "iêu yêu oai oao oay oeo uây uôi uya uyê uyu ươi ươu").split(" "),
);
const PLAIN_NUCLEI = new Set([...NUCLEI].map((n) => fold(n)));
const SYLLABLE_SHAPE = new RegExp(`^${ONSET}([aăâeêioôơuưy]+)(ch|ng|nh|[cmnpt])?$`);
const TONE_MARKS: Record<string, string> = { "̀": "grave", "́": "acute", "̉": "hook", "̃": "tilde", "̣": "dot" };

/** Where the tone mark may sit inside the vowel group (indexes into it), by the usual rules for Vietnamese spelling. */
function toneSlots(nucleus: string, hasCoda: boolean): number[] {
  const marked = [...nucleus].map((c, i) => (/[ăâêôơư]/.test(c) ? i : -1)).filter((i) => i >= 0);
  if (marked.length) return [marked[marked.length - 1]!];
  if (nucleus.length === 1) return [0];
  if (nucleus.length === 3) return [1];
  if (hasCoda) return [1];
  return ["oa", "oe", "uy"].includes(nucleus) ? [0, 1] : [0];
}

/** One word of a name: false only when it carries Vietnamese marks but cannot be a Vietnamese syllable. */
function validWord(word: string): boolean {
  if (!/^\p{L}+$/u.test(word) || !hasVietnamese(word)) return true;
  let tone = "";
  let toneAt = -1;
  let plain = "";
  for (const cluster of word.normalize("NFD").match(/\P{M}\p{M}*/gu) ?? []) {
    let base = cluster;
    for (const [mark, name] of Object.entries(TONE_MARKS)) {
      if (!base.includes(mark)) continue;
      if (tone) return false; // two tones on one word
      tone = name;
      toneAt = plain.length;
      base = base.replace(mark, "");
    }
    plain += base.normalize("NFC").toLowerCase();
  }
  const m = SYLLABLE_SHAPE.exec(plain);
  if (!m || !NUCLEI.has(m[1]!)) return false;
  const nucleus = m[1]!;
  const coda = m[2] ?? "";
  // Syllables that end in c, ch, p or t only carry the rising or the heavy tone.
  if (/^(c|ch|p|t)$/.test(coda) && tone && tone !== "acute" && tone !== "dot") return false;
  // ch and nh only follow a, ê, i, y.
  if ((coda === "ch" || coda === "nh") && !/[aêiy]$/.test(nucleus)) return false;
  if (tone) {
    const start = plain.length - coda.length - nucleus.length;
    if (!toneSlots(nucleus, coda !== "").includes(toneAt - start)) return false;
  }
  return true;
}

/** True when every word that holds Vietnamese marks is a possible Vietnamese syllable: catches invented spellings. */
export function validSyllables(text: string): boolean {
  return text.normalize("NFC").split(/[^\p{L}]+/u).every(validWord);
}

/**
 * The guard for AI answers: the suggestion may only add marks and change case, never change or add letters, it must
 * really hold Vietnamese letters (so a model that just capitalises an English name is not a fix), and every accented
 * word must be a possible Vietnamese syllable (so an invented spelling is not offered).
 */
export function onlyAddsMarks(original: string, suggestion: string): boolean {
  return suggestion.trim() !== "" && suggestion !== original && hasVietnamese(suggestion) && fold(original) === fold(suggestion) && validSyllables(suggestion);
}

/** What the library already says about how names are accented, used to ground the AI. */
export interface NameContext {
  /** Accented spellings already used in the library for the words of this name: "nguoi=người". */
  hints: string[];
  /** Names of the same artist or album that already have accents. */
  samples: string[];
}

interface Named { artist: string; album: string; title: string; deleted?: boolean }

/** Builds, once per scan, the lookup that gives each name its library hints and accented neighbours. */
export function nameContexts(tracks: Named[]): (kind: "title" | "album" | "artist", text: string, artist?: string, album?: string) => NameContext {
  const vocab = new Map<string, Map<string, number>>();
  const byArtist = new Map<string, Set<string>>();
  const byAlbum = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    if (!k) return;
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  for (const t of tracks) {
    if (t.deleted) continue;
    for (const name of [t.title, t.album, t.artist]) {
      if (!name || !hasVietnamese(name)) continue;
      for (const w of name.normalize("NFC").split(/[^\p{L}]+/u)) {
        if (!w || !hasVietnamese(w)) continue;
        const lower = w.toLowerCase();
        const f = fold(lower);
        const forms = vocab.get(f) ?? new Map<string, number>();
        forms.set(lower, (forms.get(lower) ?? 0) + 1);
        vocab.set(f, forms);
      }
    }
    for (const name of [t.title, t.album]) {
      if (name && hasVietnamese(name)) {
        add(byArtist, t.artist, name);
        add(byAlbum, t.album, name);
      }
    }
  }
  return (kind, text, artist, album) => {
    const hints: string[] = [];
    const seen = new Set<string>();
    for (const w of fold(text).split(/[^a-z0-9]+/)) {
      const forms = vocab.get(w);
      if (!w || !forms || seen.has(w) || hints.length >= 12) continue;
      seen.add(w);
      const top = [...forms].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
      hints.push(`${w}=${top.join("/")}`);
    }
    const pool =
      kind === "artist" ? [...(byArtist.get(text) ?? [])] : kind === "album" ? [...(byAlbum.get(text) ?? [])] : [...(byAlbum.get(album ?? "") ?? []), ...(byArtist.get(artist ?? "") ?? [])];
    const samples = [...new Set(pool)].filter((x) => x !== text).slice(0, 3);
    return { hints, samples };
  };
}
