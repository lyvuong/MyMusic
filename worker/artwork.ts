/** Online cover lookups: album covers from the iTunes Search API, artist pictures from Deezer. Neither needs a key. */

export interface Image {
  data: ArrayBuffer;
  type: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const similar = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/** Prefers an exact name match over a looser "contains" one ("Adele" vs "Adele & The Chandeliers"). */
function best<T>(items: T[] | undefined, name: (x: T) => string, want: string, ok: (x: T) => boolean = () => true): T | undefined {
  const c = (items ?? []).filter(ok);
  return c.find((x) => norm(name(x)) === norm(want)) ?? c.find((x) => similar(name(x), want));
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "MyMusic/1.0" } }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as T | null) : null;
}

async function getImage(url: string): Promise<Image | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const type = res?.headers.get("Content-Type") ?? "";
  if (!res?.ok || !type.startsWith("image/")) return null;
  const data = await res.arrayBuffer();
  return data.byteLength > 0 && data.byteLength <= 3_000_000 ? { data, type } : null;
}

/** Album cover for a track, or null when nothing trustworthy turns up (the artist must roughly match). */
export async function findAlbumArt(artist: string, album: string, title: string): Promise<Image | null> {
  if (!artist || !(album || title)) return null;
  const q = encodeURIComponent(`${artist} ${album || title}`);
  const r = await getJson<{ results?: { artistName: string; collectionName?: string; artworkUrl100?: string }[] }>(
    `https://itunes.apple.com/search?term=${q}&entity=${album ? "album" : "song"}&limit=5`,
  );
  const hit = best(r?.results, (x) => x.artistName, artist, (x) => !!x.artworkUrl100 && (!album || similar(x.collectionName ?? "", album)));
  return hit?.artworkUrl100 ? getImage(hit.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb.")) : null;
}

/** Artist picture, or null. */
export async function findArtistImage(name: string): Promise<Image | null> {
  if (!name) return null;
  const r = await getJson<{ data?: { name: string; picture_xl?: string }[] }>(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=3`);
  const hit = best(r?.data, (x) => x.name, name, (x) => !!x.picture_xl);
  return hit?.picture_xl ? getImage(hit.picture_xl) : null;
}
