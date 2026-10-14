import { describe, expect, it } from "vitest";
import { autoApplicable } from "./albumjob";

const g = (confidence: number, sources: string[]) => ({ album: "A", artist: "B", confidence, sources });

describe("autoApplicable", () => {
  it("needs two sources and 95%", () => {
    expect(autoApplicable(g(0.98, ["iTunes", "Deezer"]))).toBe(true);
    expect(autoApplicable(g(0.95, ["iTunes", "AcoustID"]))).toBe(true);
    expect(autoApplicable(g(0.9, ["iTunes", "Deezer"]))).toBe(false); // one source's best is 90%
    expect(autoApplicable(g(0.98, ["iTunes"]))).toBe(false);
    expect(autoApplicable(undefined)).toBe(false);
  });
});
