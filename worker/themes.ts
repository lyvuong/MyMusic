import { fold, hasVietnamese } from "../shared/vietnamese";
import type { Row } from "./suggest";

/**
 * Themed mixes: about an hour of music for a mood or style (Vietnamese, pop, love songs, instrumental, ...), picked from
 * the whole library without the AI. Each night every theme is drawn again from all songs that fit, so the lists stay
 * different from day to day: songs used in yesterday's mixes, and songs another mix took tonight, are pushed down, and
 * no artist fills a mix.
 */

export const THEME_PREFIX = "theme-";
export const TARGET_SECONDS = 3600;
const MAX_TRACKS = 30;
const MIN_TRACKS = 12; // fewer songs than this is not a mix
const DEFAULT_SECONDS = 210; // for songs whose length is not known
const JITTER = 3; // how far chance can move a song up or down the taste ranking
const AVOID_PENALTY = 2.5; // used in yesterday's mixes
const TAKEN_PENALTY = 3; // used in another mix tonight
const DROP_AFTER_SKIPS = 3;
const GENRE_THEMES = 4; // extra themes made from the library's biggest genres
const GENRE_MIN_SONGS = 30;
const SPOTLIGHTS = 3;

/** A song with what the themes look at, computed once. */
export interface Feat {
  row: Row;
  seconds: number;
  /** Lowercase, no accents, of title, artist and album. */
  text: string;
  genre: string;
  vietnamese: boolean;
}

interface Theme {
  slug: string;
  title: string;
  tagline: string;
  test: (f: Feat) => boolean;
  /** Extra score for songs the theme fits best. */
  bonus?: (f: Feat) => number;
  /** Songs the per-artist limit does not apply to (a spotlight is about one artist). */
  exempt?: (f: Feat) => boolean;
}

const has = (re: RegExp) => (f: Feat) => re.test(f.genre) || re.test(f.text);
const genreHas = (re: RegExp) => (f: Feat) => re.test(f.genre);

const LOVE = /\b(love|lover|loves|loving|heart|hearts|romance|romantic|kiss|valentine|darling|honey|forever|yeu|tinh|thuong|nho)\b/;
const INSTRUMENTAL = /\b(instrumental|piano|orchestra|orchestral|classical|symphony|ambient|new age|soundtrack|score|violin|cello|saxophone)\b/;

/** Fixed themes, in the order they are shown. */
const THEMES: Theme[] = [
  { slug: "vietnamese", title: "Nhạc Việt", tagline: "Vietnamese songs, old and new", test: (f) => f.vietnamese },
  { slug: "pop", title: "Pop Hits", tagline: "Bright, catchy pop", test: (f) => !f.vietnamese && /\bpop\b/.test(f.genre), bonus: (f) => (f.row.fame ?? 0) * 0.5 },
  { slug: "love", title: "Love Songs", tagline: "Romantic songs for the long drive", test: (f) => LOVE.test(f.text) || /ballad|romantic|love/.test(f.genre) },
  { slug: "instrumental", title: "Instrumental", tagline: "Music without words, to relax or focus", test: has(INSTRUMENTAL) },
  { slug: "chill", title: "Chill Out", tagline: "Easy, mellow and unhurried", test: genreHas(/chill|lounge|jazz|blues|bossa|soft|mellow|easy listening/) },
  { slug: "acoustic", title: "Acoustic & Folk", tagline: "Warm guitars and honest voices", test: has(/\b(acoustic|folk|country|unplugged|singer songwriter|bluegrass)\b/) },
  { slug: "rock", title: "Rock Anthems", tagline: "Guitars up, windows down", test: genreHas(/rock|metal|punk|grunge|alternative|indie/) },
  { slug: "hiphop", title: "Hip-Hop & R&B", tagline: "Beats, flow and soul", test: genreHas(/hip|rap|r&b|rnb|soul|funk/) },
  { slug: "dance", title: "Dance & Electronic", tagline: "Up-tempo energy for the road", test: (f) => /dance|electro|edm|house|techno|disco|club|trance/.test(f.genre) || /\bremix\b/.test(f.text) },
  { slug: "favourites", title: "Family Favourites", tagline: "What the family keeps playing", test: (f) => (f.row.plays ?? 0) > 0, bonus: (f) => Math.log1p(f.row.plays ?? 0) },
  { slug: "fresh", title: "Fresh Finds", tagline: "Songs you have not heard lately", test: (f) => !f.row.myPlays && !f.row.plays && f.row.rating === null, bonus: (f) => (f.row.fame ?? 0) * 0.6 },
];

export interface ThemedMix {
  key: string;
  title: string;
  intro: string;
  trackIds: string[];
  cover: string;
  rank: number;
}

export function features(rows: Row[]): Feat[] {
  return rows.map((row) => {
    const raw = `${row.title} ${row.artist} ${row.album}`;
    const genre = fold(row.genre ?? "");
    return {
      row,
      seconds: row.duration && row.duration > 0 ? row.duration : DEFAULT_SECONDS,
      text: fold(raw),
      genre,
      vietnamese: hasVietnamese(raw) || /viet|v-?pop|nhac/.test(genre),
    };
  });
}

/** A song the listener asked not to hear: rated 1-2, or skipped again and again without being loved. */
function unwanted(r: Row): boolean {
  if (r.rating !== null && r.rating <= 2) return true;
  return (r.skips ?? 0) >= DROP_AFTER_SKIPS && (r.rating === null || r.rating < 4);
}

/** How much the listener's own taste likes a song, without any theme. */
function taste(f: Feat, artistAvg: Map<string, number>): number {
  const r = f.row;
  const liked = r.rating !== null && r.rating >= 4 ? 2 + (r.rating - 4) : 0;
  const artist = ((artistAvg.get(r.artist) ?? 3) - 3) * 0.5;
  return liked + artist + Math.log1p(r.myPlays ?? 0) * 0.4 + Math.log1p(r.plays ?? 0) * 0.3 + (r.fame ?? 0) * 0.3 - Math.min(r.skips ?? 0, 3) * 0.5;
}

/** Rating average of each artist, over the songs the listener rated. */
function artistAverages(rows: Row[]): Map<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  for (const r of rows) {
    if (r.rating === null || !r.artist) continue;
    const a = sums.get(r.artist) ?? { s: 0, n: 0 };
    a.s += r.rating;
    a.n++;
    sums.set(r.artist, a);
  }
  return new Map([...sums].map(([k, v]) => [k, v.s / v.n]));
}

interface Pick { ids: string[]; seconds: number; cover: string; artists: string[] }

/**
 * About an hour from [pool]: best score first, at most `cap` songs per artist (relaxed if the pool is too narrow to
 * fill the hour), then ordered so the same artist is never next to itself.
 */
export function pickHour(pool: { f: Feat; score: number }[], rng: () => number, exempt?: (f: Feat) => boolean): Pick | null {
  const sorted = [...pool].sort((a, b) => b.score - a.score);
  let chosen: { f: Feat; score: number }[] = [];
  for (const cap of [2, 4, Infinity]) {
    chosen = [];
    const perArtist = new Map<string, number>();
    let seconds = 0;
    for (const c of sorted) {
      if (seconds >= TARGET_SECONDS || chosen.length >= MAX_TRACKS) break;
      const a = c.f.row.artist;
      const n = perArtist.get(a) ?? 0;
      if (a && n >= cap && !exempt?.(c.f)) continue;
      perArtist.set(a, n + 1);
      chosen.push(c);
      seconds += c.f.seconds;
    }
    if (seconds >= TARGET_SECONDS * 0.8) break;
  }
  if (chosen.length < MIN_TRACKS) return null;

  const order = chosen.map((c) => ({ c, k: rng() })).sort((a, b) => a.k - b.k).map((x) => x.c);
  for (let i = 1; i < order.length; i++) {
    if (!order[i].f.row.artist || order[i].f.row.artist !== order[i - 1].f.row.artist) continue;
    const j = order.findIndex((x, k) => k > i && x.f.row.artist !== order[i - 1].f.row.artist);
    if (j > 0) [order[i], order[j]] = [order[j], order[i]];
  }

  // The cover: an album that has art and that most of the picked songs come from.
  const byAlbum = new Map<string, { n: number; id: string }>();
  for (const c of order) {
    const r = c.f.row;
    if (!r.hasArt || !r.album) continue;
    const e = byAlbum.get(r.album);
    if (e) e.n++;
    else byAlbum.set(r.album, { n: 1, id: r.id });
  }
  const best = [...byAlbum.values()].sort((a, b) => b.n - a.n)[0];
  const cover = best?.id ?? order.find((c) => c.f.row.hasArt)?.f.row.id ?? "";

  const counts = new Map<string, number>();
  for (const c of order) if (c.f.row.artist) counts.set(c.f.row.artist, (counts.get(c.f.row.artist) ?? 0) + 1);
  const artists = [...counts].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  return { ids: order.map((c) => c.f.row.id), seconds: chosen.reduce((s, c) => s + c.f.seconds, 0), cover, artists };
}

const minutes = (s: number) => Math.max(1, Math.round(s / 60));

/**
 * The themed mixes for one member from the whole library. `avoid` holds yesterday's songs (any mix): they come back
 * only when nothing else fits. Themes with too few songs are left out.
 */
export function buildThemedMixes(rows: Row[], avoid: Set<string>, spotlightArtists: string[], rng: () => number = Math.random): ThemedMix[] {
  const feats = features(rows).filter((f) => !unwanted(f.row));
  const avg = artistAverages(rows);
  const base = new Map(feats.map((f) => [f.row.id, taste(f, avg)]));
  const taken = new Set<string>();

  const themes: Theme[] = [...THEMES];
  // The biggest genres the fixed themes do not cover.
  const covered = THEMES.filter((t) => t.slug !== "favourites" && t.slug !== "fresh");
  const genreCount = new Map<string, number>();
  for (const f of feats) if (f.genre && !covered.some((t) => t.test(f))) genreCount.set(f.genre, (genreCount.get(f.genre) ?? 0) + 1);
  const named = new Map<string, string>();
  for (const f of feats) if (f.genre && !named.has(f.genre)) named.set(f.genre, f.row.genre!.trim());
  for (const [g] of [...genreCount].filter(([, n]) => n >= GENRE_MIN_SONGS).sort((a, b) => b[1] - a[1]).slice(0, GENRE_THEMES)) {
    const name = named.get(g) ?? g;
    themes.push({ slug: `genre-${g.replace(/[^a-z0-9]+/g, "-")}`, title: `${name} Mix`, tagline: `The best of ${name} in the library`, test: (f) => f.genre === g });
  }
  // Artists the listener loves most, with songs that sound like them (same genre) after their own.
  for (const name of spotlightArtists.slice(0, SPOTLIGHTS)) {
    const own = feats.filter((f) => f.row.artist === name);
    if (own.length < 4) continue;
    const genres = new Set(own.map((f) => f.genre).filter(Boolean));
    themes.push({
      slug: `artist-${fold(name).replace(/[^a-z0-9]+/g, "-")}`,
      title: `${name} & More`,
      tagline: `${name}, and songs in the same spirit`,
      test: (f) => f.row.artist === name || (genres.size > 0 && genres.has(f.genre)),
      bonus: (f) => (f.row.artist === name ? 3 : 0),
      exempt: (f) => f.row.artist === name,
    });
  }

  const out: ThemedMix[] = [];
  for (const t of themes) {
    const pool = feats.filter(t.test).map((f) => ({
      f,
      score: base.get(f.row.id)! + (t.bonus?.(f) ?? 0) + rng() * JITTER - (avoid.has(f.row.id) ? AVOID_PENALTY : 0) - (taken.has(f.row.id) ? TAKEN_PENALTY : 0),
    }));
    if (pool.length < MIN_TRACKS) continue;
    const p = pickHour(pool, rng, t.exempt);
    if (!p) continue;
    for (const id of p.ids) taken.add(id);
    out.push({
      key: THEME_PREFIX + t.slug,
      title: t.title,
      intro: `${t.tagline} · ${minutes(p.seconds)} min`,
      trackIds: p.ids,
      cover: p.cover,
      rank: out.length,
    });
  }
  return out;
}
