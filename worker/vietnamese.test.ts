import { describe, expect, it } from "vitest";
import { restoreAccents } from "./vietnamese";

// No AI binding: anything that is answered from the family's corrections must not need it.
const env = {} as Parameters<typeof restoreAccents>[0];

describe("restoreAccents with learned corrections", () => {
  const learned = [
    { from: "Hoa Mua Xuan", to: "Hoa Mùa Xuân" },
    { from: "Bad Moon", to: "Bad Moon" },
  ];

  it("answers an exact repeat from the correction, whitespace aside", async () => {
    const r = await restoreAccents(env, [{ key: "a", text: "  Hoa  Mua Xuan " }], learned);
    expect(r).toEqual([{ key: "a", text: "Hoa Mùa Xuân" }]);
  });

  it("suggests nothing for a name the owner said to leave alone", async () => {
    expect(await restoreAccents(env, [{ key: "a", text: "Bad Moon" }], learned)).toEqual([]);
  });

  it("still needs the AI for names it has not seen", async () => {
    await expect(restoreAccents(env, [{ key: "a", text: "Tinh Ca" }], learned)).rejects.toThrow("AI is not configured");
  });
});
