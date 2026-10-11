import { describe, expect, it } from "vitest";
import { goneFromServer } from "./beets";

const run = (over: Partial<{ id: string; status: "requested" | "running" | "done" | "failed"; startedAt: number | null; requestedAt: number }> = {}) =>
  ({ id: "r1", status: "running" as const, startedAt: 1_000_000, requestedAt: 1_000_000, ...over });

describe("goneFromServer", () => {
  const later = 1_000_000 + 5 * 60 * 1000;

  it("is true for a running run the server no longer lists", () => {
    expect(goneFromServer(run(), [{ id: "other" }], later)).toBe(true);
  });

  it("is false while the server lists it", () => {
    expect(goneFromServer(run(), [{ id: "r1" }], later)).toBe(false);
  });

  it("gives a run that just started time to appear", () => {
    expect(goneFromServer(run(), [], 1_000_000 + 10_000)).toBe(false);
  });

  it("only judges running runs", () => {
    expect(goneFromServer(run({ status: "requested" }), [], later)).toBe(false);
    expect(goneFromServer(run({ status: "done" }), [], later)).toBe(false);
  });
});
