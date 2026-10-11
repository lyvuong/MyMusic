import { describe, expect, it } from "vitest";
import { changedSongs, goneSongIds, type NasSong, type StoredSong } from "./nas";

const song = (key: string, over: Partial<NasSong> = {}): NasSong => ({
  key, title: `t-${key}`, artist: "a", album: "b", duration: 200, trackNo: 1, artKey: `nas:${key}`, size: 1000, mime: "audio/mpeg", ...over,
});

const stored = (s: NasSong, over: Partial<StoredSong> = {}): StoredSong => ({
  title: s.title, artist: s.artist, album: s.album, duration: s.duration, track_no: s.trackNo,
  art_key: s.artKey, size: s.size, mime: s.mime, edited: 0, deleted: 0, ...over,
});

const library = (songs: NasSong[], over: Partial<StoredSong> = {}) => new Map(songs.map((s) => [s.key, stored(s, over)]));

describe("changedSongs", () => {
  it("writes nothing for a library that has not changed", () => {
    const songs = [song("1"), song("2"), song("3")];
    expect(changedSongs(library(songs), songs)).toEqual([]);
  });

  it("writes a song that is new", () => {
    const old = [song("1")];
    const now = [song("1"), song("2")];
    expect(changedSongs(library(old), now).map((s) => s.key)).toEqual(["2"]);
  });

  it("writes a song whose file changed", () => {
    const old = [song("1"), song("2")];
    const now = [song("1"), song("2", { duration: 201 })];
    expect(changedSongs(library(old), now).map((s) => s.key)).toEqual(["2"]);
  });

  it("writes a song whose cover or size changed", () => {
    const old = [song("1"), song("2")];
    const now = [song("1", { artKey: null }), song("2", { size: 5 })];
    expect(changedSongs(library(old), now).map((s) => s.key)).toEqual(["1", "2"]);
  });

  it("writes a song that came back after being removed", () => {
    const s = song("1");
    expect(changedSongs(library([s], { deleted: 1 }), [s])).toEqual([s]);
  });

  it("writes a renamed song that was not edited in the web app", () => {
    const old = song("1");
    const now = song("1", { title: "New name" });
    expect(changedSongs(library([old]), [now])).toEqual([now]);
  });

  it("ignores name changes on a song that was edited in the web app", () => {
    const old = song("1");
    const now = song("1", { title: "Other", artist: "x", album: "y", trackNo: 9 });
    expect(changedSongs(library([old], { edited: 1 }), [now])).toEqual([]);
  });

  it("still writes an edited song when its file changed", () => {
    const old = song("1");
    const now = song("1", { size: 2000 });
    expect(changedSongs(library([old], { edited: 1 }), [now])).toEqual([now]);
  });
});

describe("goneSongIds", () => {
  const live = [
    { id: "r1", source_key: "1" },
    { id: "r2", source_key: "2" },
    { id: "r3", source_key: "3" },
  ];

  it("returns only the songs the NAS no longer lists", () => {
    expect(goneSongIds(live, ["1", "3"])).toEqual(["r2"]);
  });

  it("returns nothing when every song is still listed", () => {
    expect(goneSongIds(live, ["3", "2", "1", "4"])).toEqual([]);
  });
});
