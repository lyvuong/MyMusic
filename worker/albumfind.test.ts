import { describe, expect, it } from "vitest";
import { scoreAlbums, type Hit } from "./albumfind";

const hit = (source: Hit["source"], album: string, track = "Yesterday", artist = "The Beatles", seconds?: number): Hit => ({ source, artist, track, album, seconds });

describe("scoreAlbums", () => {
  it("ranks the album both catalogues agree on, with a fitting length, first", () => {
    const r = scoreAlbums([hit("iTunes", "Help!", "Yesterday", "The Beatles", 125), hit("Deezer", "Help!", "Yesterday", "The Beatles", 126), hit("iTunes", "1", "Yesterday", "The Beatles", 125)], "The Beatles", "Yesterday", 125);
    expect(r[0]!.album).toBe("Help!");
    expect(r[0]!.confidence).toBeGreaterThan(r[1]!.confidence);
    expect(r[0]!.sources.sort()).toEqual(["Deezer", "iTunes"]);
  });
  it("drops other artists and other songs", () => {
    expect(scoreAlbums([hit("iTunes", "Covers", "Yesterday", "Some Band"), hit("iTunes", "Other", "Tomorrow")], "The Beatles", "Yesterday")).toEqual([]);
  });
  it("lowers compilations and matches without accents", () => {
    const r = scoreAlbums([hit("iTunes", "Greatest Hits", "Còn Yêu Em Mãi", "Khánh Ly"), hit("iTunes", "Tình Ca", "Còn Yêu Em Mãi", "Khánh Ly")], "Khanh Ly", "Con Yeu Em Mai");
    expect(r[0]!.album).toBe("Tình Ca");
    expect(r[0]!.confidence).toBe(0.82);
  });
});
