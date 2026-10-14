import { describe, expect, it } from "vitest";
import { nameContexts, cleanVietnamese, decodeTyped, fold, hasVietnamese, maybeNeedsAccents, onlyAddsMarks } from "./vietnamese";

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

  it("reports a decomposed name as a change of form only", () => {
    const decomposed = "Khánh Hà";
    const r = cleanVietnamese(decomposed);
    expect(r?.reason).toBe("form");
    expect(r?.text).toBe("Khánh Hà");
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
    expect(maybeNeedsAccents("Perfect Day", true)).toBe(false); // English words stay out even with a Vietnamese artist
    expect(maybeNeedsAccents("Tinh Ca", true)).toBe(true);
    expect(maybeNeedsAccents("Blue Moon")).toBe(false);
    const vocab = new Set(Array.from({ length: 200 }, (_, i) => `w${i}`).concat(["tinh"]));
    expect(maybeNeedsAccents("Tinh", false, vocab)).toBe(true); // one word the library already accents
    expect(maybeNeedsAccents("Nho", false, vocab)).toBe(false);
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

describe("validSyllables", () => {
  it("accepts real Vietnamese words and leaves unmarked words alone", () => {
    expect(onlyAddsMarks("Con Yeu Em Mai", "Còn Yêu Em Mãi")).toBe(true);
    expect(onlyAddsMarks("Nguoi Yeu Dau Tien", "Người Yêu Đầu Tiên")).toBe(true);
    expect(onlyAddsMarks("Mot Lan Nua", "Một Lần Nữa")).toBe(true);
    expect(onlyAddsMarks("Khuc Hat Mua Xuan", "Khúc Hát Mùa Xuân")).toBe(true);
    expect(onlyAddsMarks("Anh Yeu Em", "Anh Yêu Em")).toBe(true);
  });

  it("rejects invented spellings", () => {
    expect(onlyAddsMarks("Nguoi Yeu", "Ngừơi Yểu")).toBe(false); // tone on ư instead of ơ
    expect(onlyAddsMarks("Mat Troi", "Mằt Trời")).toBe(false); // grave tone on a -t syllable
    expect(onlyAddsMarks("Dem Mua", "Đêm Mưạ")).toBe(false); // tone on the wrong vowel
    expect(onlyAddsMarks("Mot Lan", "Mộtt Lần")).toBe(false);
  });
});

describe("nameContexts", () => {
  const tracks = [
    { artist: "Trịnh Công Sơn", album: "Tình Ca", title: "Còn Yêu Em Mãi" },
    { artist: "Trịnh Công Sơn", album: "Tình Ca", title: "Nhớ Một Người" },
    { artist: "Trinh Cong Son", album: "Tinh Ca", title: "Nguoi Ve" },
  ];
  const ctx = nameContexts(tracks);

  it("gives the spellings the library already uses", () => {
    expect(ctx("title", "Con Yeu Em Mai", "Trinh Cong Son", "Tinh Ca").hints).toContain("yeu=yêu");
    expect(ctx("title", "Nguoi Ve").hints).toContain("nguoi=người");
  });

  it("gives accented names of the same artist or album", () => {
    expect(ctx("artist", "Trịnh Công Sơn").samples).toEqual(["Còn Yêu Em Mãi", "Tình Ca", "Nhớ Một Người"]);
    expect(ctx("title", "Nguoi Ve", "Trinh Cong Son", "Tinh Ca").samples).toEqual([]);
  });
});
