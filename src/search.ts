import type { Track } from "../shared/types";
import { fold } from "./EditDialog";

/** Folded (lowercase, no accents, đ -> d) title and title+artist+album text of every song, built once per library change. */
export interface SearchIndex {
  title: Map<string, string>;
  all: Map<string, string>;
}

export function buildIndex(tracks: Track[]): SearchIndex {
  const title = new Map<string, string>();
  const all = new Map<string, string>();
  for (const t of tracks) {
    title.set(t.id, fold(t.title));
    all.set(t.id, fold(`${t.title} ${t.artist} ${t.album}`));
  }
  return { title, all };
}

/**
 * Songs matching every typed word (any order, accents and case ignored, in the title, artist or album), best first:
 * title starts with the text, then a title word starts with it, then all words start title words, then all words are
 * somewhere in the title, then matches found only in the artist or album. `tracks` should already be in the order
 * wanted for equal scores (the sort is stable). An empty query returns the list as it is.
 */
export function searchTracks(tracks: Track[], index: SearchIndex, query: string): Track[] {
  const q = fold(query);
  if (!q) return tracks;
  const words = q.split(" ");
  const scored: { t: Track; s: number }[] = [];
  for (const t of tracks) {
    const all = index.all.get(t.id) ?? "";
    if (!words.every((w) => all.includes(w))) continue;
    const title = index.title.get(t.id) ?? "";
    const tw = title.split(" ");
    const s = title.startsWith(q) ? 0
      : ` ${title}`.includes(` ${q}`) ? 1
      : words.every((w) => tw.some((x) => x.startsWith(w))) ? 2
      : words.every((w) => title.includes(w)) ? 3
      : 4;
    scored.push({ t, s });
  }
  return scored.sort((a, b) => a.s - b.s).map((x) => x.t);
}
