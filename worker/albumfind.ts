/**
 * Suggests the album of a song that has none, from online catalogues (iTunes Search and Deezer; neither needs a key).
 * Every suggestion is a real release the catalogue lists for the same artist and song title, with a confidence from
 * how well the names match, whether both catalogues agree and whether the length fits. Nothing is invented by a model.
 */

export interface Hit { source: "iTunes" | "Deezer"; artist: string; track: string; album: string; seconds?: number }
export interface AlbumGuess { album: string; artist: string; confidence: number; sources: string[] }

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** 1 for the same name, 0.7 when one contains the other, 0 otherwise. */
function nameScore(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return x.includes(y) || y.includes(x) ? 0.7 : 0;
}

const COMPILATION = /\b(greatest hits|best of|the best|hits|collection|compilation|now that|anthology|essential|playlist|top \d+|nhac)\b/i;

/** Pure scoring of the catalogue hits for one song (see the file comment). Most confident first, at most 3, 40% and up. */
export function scoreAlbums(hits: Hit[], artist: string, title: string, seconds = 0): AlbumGuess[] {
  const by = new Map<string, { album: string; artist: string; match: number; near: boolean; far: boolean; sources: Set<string> }>();
  for (const h of hits) {
    if (!h.album) continue;
    const t = nameScore(h.track, title);
    const a = nameScore(h.artist, artist);
    if (t === 0 || a === 0) continue;
    const match = 0.6 * t + 0.4 * a;
    const key = norm(h.album);
    if (!key) continue;
    const e = by.get(key) ?? { album: h.album, artist: h.artist, match: 0, near: false, far: false, sources: new Set<string>() };
    if (match > e.match) { e.match = match; e.album = h.album; e.artist = h.artist; }
    e.sources.add(h.source);
    if (seconds > 0 && h.seconds) {
      if (Math.abs(h.seconds - seconds) <= 3) e.near = true;
      else if (Math.abs(h.seconds - seconds) > 15) e.far = true;
    }
    by.set(key, e);
  }
  const out: AlbumGuess[] = [];
  for (const e of by.values()) {
    // A perfect name match alone is 82%; a second catalogue and a fitting length are what take it higher.
    let c = e.match * 0.82;
    if (e.sources.size > 1) c += 0.1;
    if (e.near) c += 0.08;
    else if (e.far) c -= 0.1;
    if (COMPILATION.test(e.album)) c -= 0.15;
    c = Math.min(0.98, Math.max(0, c));
    if (c >= 0.4) out.push({ album: e.album, artist: e.artist, confidence: Math.round(c * 100) / 100, sources: [...e.sources] });
  }
  return out.sort((x, y) => y.confidence - x.confidence).slice(0, 3);
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "MyMusic/1.0" } }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as T | null) : null;
}

export async function findAlbums(artist: string, title: string, seconds = 0): Promise<AlbumGuess[]> {
  if (!artist || !title) return [];
  const [it, dz] = await Promise.all([
    getJson<{ results?: { artistName?: string; trackName?: string; collectionName?: string; trackTimeMillis?: number }[] }>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&entity=song&limit=15`,
    ),
    getJson<{ data?: { title?: string; duration?: number; artist?: { name?: string }; album?: { title?: string } }[] }>(
      `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}&limit=15`,
    ),
  ]);
  const hits: Hit[] = [
    ...(it?.results ?? []).map((r): Hit => ({ source: "iTunes", artist: r.artistName ?? "", track: r.trackName ?? "", album: r.collectionName ?? "", seconds: r.trackTimeMillis ? r.trackTimeMillis / 1000 : undefined })),
    ...(dz?.data ?? []).map((r): Hit => ({ source: "Deezer", artist: r.artist?.name ?? "", track: r.title ?? "", album: r.album?.title ?? "", seconds: r.duration })),
  ];
  return scoreAlbums(hits, artist, title, seconds);
}
