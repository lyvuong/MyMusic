import type { Track } from "./types";

/** An artist (or album) with some songs marked as AI and some not: the unmarked ones are suggested. */
export interface AiSuggestion {
  kind: "artist" | "album";
  name: string;
  /** How many of its songs carry the badge, and how many in all. */
  ai: number;
  total: number;
  /** The songs without the badge. */
  rest: Track[];
  /** At least half of its songs are AI, so it is likely the rest are too. */
  likely: boolean;
}

/**
 * Artists and albums where some songs are marked AI and others are not. Likely ones (half or more marked) lead, then
 * the ones with the most marked songs.
 */
export function suggestAi(tracks: Iterable<Track>): AiSuggestion[] {
  const groups = new Map<string, { kind: "artist" | "album"; name: string; all: Track[] }>();
  const add = (kind: "artist" | "album", name: string, t: Track) => {
    if (!name) return;
    const key = `${kind}\u0000${name}`;
    const g = groups.get(key) ?? { kind, name, all: [] };
    g.all.push(t);
    groups.set(key, g);
  };
  for (const t of tracks) {
    if (t.deleted) continue;
    add("artist", t.artist, t);
    add("album", `${t.album}\u0001${t.artist}`, t);
  }
  const out: AiSuggestion[] = [];
  for (const g of groups.values()) {
    const ai = g.all.filter((t) => t.ai).length;
    const rest = g.all.filter((t) => !t.ai);
    if (ai === 0 || rest.length === 0) continue;
    out.push({ kind: g.kind, name: g.kind === "album" ? g.name.split("\u0001").join(" — ") : g.name, ai, total: g.all.length, rest, likely: ai * 2 >= g.all.length });
  }
  return out.sort((a, b) => Number(b.likely) - Number(a.likely) || b.ai - a.ai || a.name.localeCompare(b.name));
}
