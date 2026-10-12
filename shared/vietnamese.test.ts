import { describe, expect, it } from "vitest";
import { cleanVietnamese, decodeTyped, fold, hasVietnamese, maybeNeedsAccents, onlyAddsMarks } from "./vietnamese";

const nfc = (s: string) => s.normalize("NFC");

describe("decodeTyped", () => {
  it("decodes ASCII-typed Vietnamese", () => {
    expect(nfc(decodeTyped("Hu+o+ng Ca^`n"))).toBe(nfc("Hương Cần"));
    expect(nfc(decodeTyped("Hu*o*ng Ca^`n"))).toBe(nfc("Hương Cần"));
    expect(nfc(decodeTyped("Tri.nh Co^ng So+n"))).toBe(nfc("Trịnh Công Sơn"));
    expect(nfc(decodeTyped("dda^y la` dde^m"))).toBe(nfc("đây là đêm"));
  });

  it("leaves English and already correct text alone", () => {
    expect(decodeTyped("Let it be")).toBe("Let it be");
    expect(decodeTyped("Hương Cần")).toBe("Hương Cần");
    expect(decodeTyped("What's up? Yes.")).toBe("What's up? Yes.");
  });

  it("turns encoded spaces back into spaces", () => {
    expect(decodeTyped("Ca^`n_20Tho+")).toContain(" ");
  });
});

describe("cleanVietnamese", () => {
  it("returns null when the name is fine", () => {
    expect(cleanVietnamese("Còn Yêu Em Mãi")).toBeNull();
    expect(cleanVietnamese("Let It Be")).toBeNull();
  });

  it("capitalises words and fixes ALL CAPS and spacing in Vietnamese names", () => {
    expect(cleanVietnamese("CÒN YÊU EM MÃI")?.text).toBe("Còn Yêu Em Mãi");
    expect(cleanVietnamese("còn  yêu em mãi")?.text).toBe("Còn Yêu Em Mãi");
    expect(cleanVietnamese("  Đêm  Nhớ Về ")?.text).toBe("Đêm Nhớ Về");
  });

  it("does not touch the case of English names", () => {
    expect(cleanVietnamese("ABBA")).toBeNull();
    expect(cleanVietnamese("the beatles")).toBeNull();
  });

  it("reports typed names as typed", () => {
    expect(cleanVietnamese("Hu+o+ng Ca^`n")?.reason).toBe("typed");
    expect(cleanVietnamese("CÒN YÊU")?.reason).toBe("case");
  });
});

describe("accent candidates and the AI guard", () => {
  it("fold ignores marks, case and spacing", () => {
    expect(fold("Còn  Yêu Em Mãi")).toBe("con yeu em mai");
    expect(fold("ĐÊM")).toBe("dem");
  });

  it("flags unaccented text that could be Vietnamese", () => {
    expect(maybeNeedsAccents("Con Yeu Em Mai")).toBe(true);
    expect(maybeNeedsAccents("Tinh Ca Xua")).toBe(true);
    expect(maybeNeedsAccents("Let It Be")).toBe(false); // common English words
    expect(maybeNeedsAccents("Hotel California")).toBe(false);
    expect(maybeNeedsAccents("Còn Yêu Em Mãi")).toBe(false); // already has accents
  });

  it("treats any unaccented title as a candidate when the artist is Vietnamese", () => {
    expect(maybeNeedsAccents("Perfect Day", true)).toBe(true);
    expect(hasVietnamese("Hương")).toBe(true);
  });

  it("accepts an AI answer only when it adds marks and nothing else", () => {
    expect(onlyAddsMarks("Con Yeu Em Mai", "Còn Yêu Em Mãi")).toBe(true);
    expect(onlyAddsMarks("con yeu em mai", "Còn Yêu Em Mãi")).toBe(true);
    expect(onlyAddsMarks("Con Yeu Em Mai", "Còn Yêu Anh Mãi")).toBe(false); // changed a word
    expect(onlyAddsMarks("Con Yeu Em Mai", "Con Yeu Em Mai")).toBe(false); // nothing changed
    expect(onlyAddsMarks("Con Yeu Em Mai", "")).toBe(false);
    expect(onlyAddsMarks("Tinh Ca", "Tình Ca")).toBe(true);
    expect(onlyAddsMarks("greatest hits", "Greatest Hits")).toBe(false); // only capitals: not Vietnamese
  });
});
