import { describe, expect, it } from "vitest";
import { buildContext, DAYPARTS, DAYPART_HINT } from "./suggest";

const row = (id: string, rating: number | null, plays: number | null = null) => ({ id, title: id, artist: `a-${id}`, album: "", rating, plays });

describe("buildContext", () => {
  it("never offers disliked songs as candidates and keeps loved ones", () => {
    const rows = [row("bad", 1), row("good", 5), row("new", null)];
    const ids = buildContext(rows).candidates.map((t) => t.id);
    expect(ids).not.toContain("bad");
    expect(ids).toContain("good");
    expect(ids).toContain("new");
  });

  it("puts popular songs ahead of equally unrated ones when the pool is larger than the candidate list", () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(`s${i}`, null, i === 0 ? 50 : null));
    let hits = 0;
    for (let n = 0; n < 20; n++) if (buildContext(rows).candidates.some((t) => t.id === "s0")) hits++;
    expect(hits).toBeGreaterThan(15);
  });
});

describe("day-parts", () => {
  it("has a hint for each", () => {
    for (const d of DAYPARTS) expect(DAYPART_HINT[d].length).toBeGreaterThan(10);
  });
});

describe("skips", () => {
  const skipRow = (id: string, skips: number, rating: number | null = null, artist = `a-${id}`) =>
    ({ id, title: id, artist, album: "", rating, plays: null, skips });

  it("stops offering an unrated song after three skips, but keeps a loved one", () => {
    const rows = [skipRow("meh", 3), skipRow("twice", 2), skipRow("loved", 5, 5), skipRow("fresh", 0)];
    const ids = buildContext(rows).candidates.map((t) => t.id);
    expect(ids).not.toContain("meh");
    expect(ids).toContain("twice");
    expect(ids).toContain("loved");
    expect(ids).toContain("fresh");
  });

  it("ranks skipped songs below equal ones when the pool is larger than the candidate list", () => {
    const rows = [
      ...Array.from({ length: 400 }, (_, i) => skipRow(`s${i}`, 0)),
      skipRow("skipped", 2),
    ];
    let hits = 0;
    for (let n = 0; n < 100; n++) if (buildContext(rows).candidates.some((t) => t.id === "skipped")) hits++;
    // Without the penalty the song would be a candidate about 55% of the time (220 of 401); with it, only through the random tail (about 27%).
    expect(hits).toBeLessThan(42);
  });

  it("tells the model about songs skipped twice or more, never about loved ones", () => {
    const rows = [skipRow("a", 2), skipRow("b", 1), skipRow("c", 4, 5)];
    expect(buildContext(rows).skipped.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("the AI prompt", () => {
  it("carries the taste profile, the often-skipped songs and the well-known flag", async () => {
    const { suggest } = await import("./suggest");
    let prompt = "";
    const AI = { run: async (_m: string, o: { messages: { content: string }[] }) => ((prompt = o.messages[1]!.content), { response: { title: "T", intro: "I", tracks: [{ n: 1, why: "w" }], discover: [] } }) };
    const rows = [
      { id: "love", title: "Loved One", album: "", artist: "Fav Artist", rating: 5, plays: null, myPlays: 5, skips: null, fame: 3 },
      { id: "meh", title: "Skipped One", album: "", artist: "Other", rating: null, plays: null, skips: 2, fame: 0 },
      { id: "new", title: "New One", album: "", artist: "Third", rating: null, plays: null, skips: null, fame: 0 },
      { id: "r2", title: "R2", album: "", artist: "Fav Artist", rating: 4, plays: null, skips: null, fame: 0 },
      { id: "r3", title: "R3", album: "", artist: "Fav Artist", rating: 4, plays: null, skips: null, fame: 0 },
    ];
    await suggest({ AI } as unknown as Env, "f", "u", "", rows);
    expect(prompt).toContain("Top artists: Fav Artist (3 liked songs)");
    expect(prompt).toContain("Top songs: Fav Artist - Loved One");
    expect(prompt).toContain("Often skipped within a minute");
    expect(prompt).toContain("Other - Skipped One");
    expect(prompt).toMatch(/\|Fav Artist - Loved One\|\|!/);
  });
});
