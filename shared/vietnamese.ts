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
const SYLLABLE_OK = /^(ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|[bcdghklmnpqrstvx])?[aeiouy]+(ch|ng|nh|[cmnpt])?$/;
// Short English words that also happen to fit the syllable shape.
const ENGLISH = new Set(["the", "you", "let", "my", "is", "are", "was", "to", "of", "in", "on", "for", "all", "and", "with", "when", "this", "that", "love", "be", "it", "we", "she"]);

/**
 * True when an unaccented name could be Vietnamese: plain ASCII letters whose words all look like Vietnamese syllables
 * (no f, j, w, z). `contextIsVietnamese` is set when the artist or album already has real Vietnamese letters, which
 * makes any unaccented title a candidate. The AI answers "unchanged" for English text, so false positives are cheap.
 */
export function maybeNeedsAccents(text: string, contextIsVietnamese = false): boolean {
  if (hasVietnamese(text)) return false;
  if (!/^[A-Za-z0-9\s'"(),.&!?-]+$/.test(text)) return false;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0 || !words.some((w) => w.length >= 2)) return false;
  if (contextIsVietnamese) return true;
  return words.length >= 2 && words.every((w) => !ENGLISH.has(w) && !/[fjwz]/.test(w) && SYLLABLE_OK.test(w));
}

/**
 * The guard for AI answers: the suggestion may only add marks and change case, never change or add letters, and it must
 * really hold Vietnamese letters (so a model that just capitalises an English name is not a fix).
 */
export function onlyAddsMarks(original: string, suggestion: string): boolean {
  return suggestion.trim() !== "" && suggestion !== original && hasVietnamese(suggestion) && fold(original) === fold(suggestion);
}
