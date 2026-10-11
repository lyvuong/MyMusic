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
