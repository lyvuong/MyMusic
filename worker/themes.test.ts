import { describe, expect, it } from "vitest";
import type { Row } from "./suggest";
import { buildThemedMixes, TARGET_SECONDS } from "./themes";

/** A library of 900 songs: a third Vietnamese, a third pop, the rest rock, with 30 artists each of a few songs. */
function library(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 900; i++) {
    const kind = i % 3;
    rows.push({
      id: `t${i}`,
      title: kind === 0 ? `Tình yêu ${i}` : kind === 1 ? `Song ${i}` : `Rock ${i}`,
      artist: `Artist ${i % 30}`,
      album: `Album ${i % 60}`,
      genre: kind === 1 ? "Pop" : kind === 2 ? "Rock" : "",
      duration: 200,
      hasArt: i % 4 === 0 ? 1 : 0,
      rating: null,
    });
  }
  return rows;
}

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe("themed mixes", () => {
  it("makes hour-long mixes for the themes the library supports, each with a cover and a description", () => {
    const mixes = buildThemedMixes(library(), new Set(), [], seeded(1));
    const keys = mixes.map((m) => m.key);
    expect(keys).toContain("theme-vietnamese");
    expect(keys).toContain("theme-pop");
    expect(keys).toContain("theme-rock");
    expect(keys).not.toContain("theme-instrumental"); // nothing in the library fits
    for (const m of mixes) {
      expect(m.trackIds.length).toBeGreaterThanOrEqual(12);
      expect(m.trackIds.length * 200).toBeGreaterThanOrEqual(TARGET_SECONDS * 0.9);
      expect(new Set(m.trackIds).size).toBe(m.trackIds.length);
      expect(m.intro).toMatch(/min$/);
      expect(m.cover).not.toBe("");
    }
  });

  it("keeps any one artist from filling a mix", () => {
    const rows = library();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const pop = buildThemedMixes(rows, new Set(), [], seeded(2)).find((m) => m.key === "theme-pop")!;
    const count = new Map<string, number>();
    for (const id of pop.trackIds) count.set(byId.get(id)!.artist, (count.get(byId.get(id)!.artist) ?? 0) + 1);
    expect(Math.max(...count.values())).toBeLessThanOrEqual(2);
  });

  it("does not repeat yesterday's songs when the library has enough others", () => {
    const rows = library();
    const first = buildThemedMixes(rows, new Set(), [], seeded(3));
    const yesterday = new Set(first.flatMap((m) => m.trackIds));
    const second = buildThemedMixes(rows, yesterday, [], seeded(4));
    const pop = second.find((m) => m.key === "theme-pop")!;
    const again = pop.trackIds.filter((id) => yesterday.has(id)).length;
    // 300 pop songs, about 18 used a day: tonight's pop mix should come almost entirely from the others.
    expect(again).toBeLessThanOrEqual(2);
  });

  it("never offers songs rated 1-2", () => {
    const rows = library().map((r, i) => (i % 3 === 1 && i % 2 === 0 ? { ...r, rating: 1 } : r));
    const bad = new Set(rows.filter((r) => r.rating === 1).map((r) => r.id));
    for (const m of buildThemedMixes(rows, new Set(), [], seeded(5))) {
      expect(m.trackIds.some((id) => bad.has(id))).toBe(false);
    }
  });

  it("makes a spotlight for a loved artist with their own songs in it", () => {
    const rows = library();
    const m = buildThemedMixes(rows, new Set(), ["Artist 7"], seeded(6)).find((x) => x.key.startsWith("theme-artist-"))!;
    expect(m.title).toBe("Artist 7 & More");
    const own = rows.filter((r) => r.artist === "Artist 7").map((r) => r.id);
    expect(m.trackIds.filter((id) => own.includes(id)).length).toBeGreaterThan(5);
  });
});
