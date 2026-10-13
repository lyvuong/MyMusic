import type { TasteProfile } from "../shared/types";

/**
 * A member's taste profile: their top three artists and top three songs, from their own ratings, plays and skips.
 * Built with the nightly mixes (the library rows are already loaded then), stored, shown on the family page, and
 * given to the AI when it builds that member's mixes.
 */

const TOP = 3;
const PLAYS_CAP = 10; // plays past this add nothing: one song played 40 times should not outweigh a loved album
const SKIPS_CAP = 3;

interface Row { id: string; title: string; artist: string; rating: number | null; myPlays?: number | null; skips?: number | null }

/** Loved songs score high, songs the member keeps coming back to score up to about as much, skips take points off. */
function songScore(t: Row): number {
  const stars = t.rating === null ? 0 : (t.rating - 3) * 2;
  return stars + Math.min(t.myPlays ?? 0, PLAYS_CAP) * 0.5 - Math.min(t.skips ?? 0, SKIPS_CAP);
}

/** Songs rated 1-2 never count towards the profile, however often they were played. */
const counts = (t: Row) => t.rating === null || t.rating >= 3;

export function tasteProfile(rows: Row[]): Pick<TasteProfile, "artists" | "tracks"> {
  const scored = rows.filter(counts).map((t) => ({ t, score: songScore(t) })).filter((x) => x.score > 0);

  const tracks = [...scored]
    .sort((a, b) => b.score - a.score || (b.t.myPlays ?? 0) - (a.t.myPlays ?? 0) || a.t.title.localeCompare(b.t.title))
    .slice(0, TOP)
    .map(({ t }) => ({ id: t.id, title: t.title, artist: t.artist }));

  const byArtist = new Map<string, { score: number; songs: number }>();
  for (const { t, score } of scored) {
    if (!t.artist) continue;
    const a = byArtist.get(t.artist) ?? { score: 0, songs: 0 };
    a.score += score;
    a.songs++;
    byArtist.set(t.artist, a);
  }
  const artists = [...byArtist]
    .sort((a, b) => b[1].score - a[1].score || b[1].songs - a[1].songs || a[0].localeCompare(b[0]))
    .slice(0, TOP)
    .map(([name, a]) => ({ name, songs: a.songs }));

  return { artists, tracks };
}

export async function saveTaste(db: D1Database, familyId: string, uid: string, p: Pick<TasteProfile, "artists" | "tracks">): Promise<void> {
  await db.prepare(
    "INSERT INTO taste_profiles (uid, family_id, artists, tracks, built_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(uid) DO UPDATE SET family_id = excluded.family_id, artists = excluded.artists, tracks = excluded.tracks, built_at = excluded.built_at",
  ).bind(uid, familyId, JSON.stringify(p.artists), JSON.stringify(p.tracks), Date.now()).run();
}

const parse = <T>(s: string): T[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

/** Every member's stored profile (members who have none yet are left out). */
export async function familyTaste(db: D1Database, familyId: string): Promise<TasteProfile[]> {
  const r = await db.prepare("SELECT uid, artists, tracks, built_at FROM taste_profiles WHERE family_id = ?")
    .bind(familyId).all<{ uid: string; artists: string; tracks: string; built_at: number }>();
  return r.results.map((x) => ({
    uid: x.uid,
    artists: parse<TasteProfile["artists"][number]>(x.artists),
    tracks: parse<TasteProfile["tracks"][number]>(x.tracks),
    builtAt: x.built_at,
  }));
}
