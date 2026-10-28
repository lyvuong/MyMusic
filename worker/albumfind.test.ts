import { describe, expect, it } from "vitest";
import { mergeGuesses, scoreAlbums, soundGuesses, type Hit } from "./albumfind";

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
    expect(r[0]!.confidence).toBe(0.75);
  });
  it("skips live, tribute and karaoke takes, and Discogs alone", () => {
    const r = scoreAlbums([
      hit("iTunes", "Live 1978-1992", "Sultans of Swing (Live at the Rainbow)", "Dire Straits"),
      hit("iTunes", "A Tribute To Dire Straits", "Sultans of Swing", "Dire Straits"),
      hit("Discogs", "Are You Shakespearienced?", "Sultans of Swing", "Dire Straits"),
      hit("iTunes", "Dire Straits", "Sultans of Swing", "Dire Straits"),
    ], "Dire Straits", "Sultans of Swing");
    expect(r.map((g) => g.album)).toEqual(["Dire Straits"]);
  });
});

describe("Discogs hits", () => {
  it("count as a third catalogue", () => {
    const r = scoreAlbums([hit("iTunes", "Help!"), hit("Deezer", "Help!"), hit("Discogs", "Help!")], "The Beatles", "Yesterday");
    expect(r[0]!.sources).toHaveLength(3);
  });
});

describe("sound matches", () => {
  it("turns AcoustID matches into albums, below 90%, and ignores weak ones", () => {
    const g = soundGuesses([{ score: 0.97, title: "Còn Yêu Em Mãi", artist: "Khánh Ly", albums: ["Tình Ca"] }, { score: 0.3, title: "x", artist: "y", albums: ["Nope"] }]);
    expect(g).toEqual([{ album: "Tình Ca", artist: "Khánh Ly", title: "Còn Yêu Em Mãi", confidence: 0.87, sources: ["AcoustID"] }]);
  });
  it("is more certain when the catalogues name the same album", () => {
    const m = mergeGuesses([{ album: "Tinh Ca", artist: "Khanh Ly", confidence: 0.82, sources: ["iTunes"] }], [{ album: "Tình Ca", artist: "Khánh Ly", title: "T", confidence: 0.87, sources: ["AcoustID"] }]);
    expect(m).toHaveLength(1);
    expect(m[0]!.confidence).toBe(0.95);
    expect(m[0]!.sources).toEqual(["iTunes", "AcoustID"]);
  });
});
