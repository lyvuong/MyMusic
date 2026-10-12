import { describe, expect, it } from "vitest";
import type { Track } from "../shared/types";
import { buildIndex, searchTracks } from "./search";

const t = (id: string, title: string, artist: string, album = ""): Track => ({
  id, source: "nas", title, artist, album, duration: 200, trackNo: 1, hasArt: false, size: 1, etag: id, mime: "audio/mpeg", updatedAt: 1, deleted: false, ai: false, genre: "",
});

const lib = [
  t("1", "Để Nhớ Một Thời Ta Đã Yêu", "The Blue Note Hanoi"),
  t("2", "Hương Cần", "Hà Anh Tuấn", "Xanh"),
  t("3", "Never Gonna Give You Up", "Rick Astley", "Whenever You Need Somebody"),
  t("4", "Give Me Love", "Ed Sheeran", "Never Alone"),
  t("5", "Up", "Olly Murs"),
];
const ids = (q: string) => searchTracks(lib, buildIndex(lib), q).map((x) => x.id);

describe("searchTracks", () => {
  it("returns everything for an empty query", () => {
    expect(ids("  ")).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("ignores accents, đ and case", () => {
    expect(ids("huong can")).toEqual(["2"]);
    expect(ids("DE NHO")).toEqual(["1"]);
  });

  it("matches words in any order and across title, artist and album", () => {
    expect(ids("astley never")).toEqual(["3"]);
    expect(ids("xanh tuan")).toEqual(["2"]);
  });

  it("ranks title matches before artist or album matches", () => {
    // "never" starts song 3's title; song 4 only has it in its album
    expect(ids("never")).toEqual(["3", "4"]);
    // a title that is exactly the word comes before titles that merely contain it
    expect(ids("up")[0]).toBe("5");
  });

  it("finds nothing when a word is missing", () => {
    expect(ids("never zebra")).toEqual([]);
  });
});
