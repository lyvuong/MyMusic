import { findAlbums, mergeGuesses, soundGuesses, type AlbumGuess } from "./albumfind";
import { HomeError, homeConfigured, homeEdit, homeFingerprint } from "./home";
import { editTrack } from "./library";

/**
 * The missing-album finder as a background job, plus the pieces it shares with the button in Library tools: lookups for
 * a few songs (`suggestFor`), the saved suggestions, and the optional automatic apply. The home server is the clock
 * (see scripts/unraid/mymusic-api/albums.py); the Worker does the work a few songs per request.
 */

export interface SongRow { id: string; source: string; title: string; artist: string; album: string; track_no: number; duration: number }

/** Auto-apply only takes a guess that at least two sources agree on, at 95% or more. */
export const AUTO_MIN_CONFIDENCE = 0.95;
export const AUTO_MIN_SOURCES = 2;
export const autoApplicable = (g: AlbumGuess | undefined): g is AlbumGuess =>
  !!g && g.confidence >= AUTO_MIN_CONFIDENCE && g.sources.length >= AUTO_MIN_SOURCES;

/** Online lookups for the songs, plus a fingerprint for the ones whose files are on the home server (up to 5 songs). */
export async function suggestFor(env: Env, rows: SongRow[]): Promise<{ guesses: Map<string, AlbumGuess[]>; soundNote: string }> {
  const nas = rows.filter((r) => r.source === "nas");
  const sound = new Map<string, AlbumGuess[]>();
  let soundNote = "";
  const soundTask = nas.length && homeConfigured(env)
    ? homeFingerprint(env, nas.map((r) => ({ title: r.title, artist: r.artist, album: r.album, trackNo: r.track_no })))
        .then((r) => nas.forEach((s, i) => sound.set(s.id, soundGuesses(r.results[i]?.matches ?? []))))
        .catch((e) => { soundNote = e instanceof Error ? e.message : "The sound lookup failed"; })
    : Promise.resolve();
  const online = Promise.all(rows.map(async (r) => ({ id: r.id, guesses: await findAlbums(r.artist, r.title, r.duration, env.DISCOGS_TOKEN) })));
  const [found] = await Promise.all([online, soundTask]);
  return { guesses: new Map(found.map((f) => [f.id, mergeGuesses(f.guesses, sound.get(f.id) ?? [])])), soundNote };
}

/** No album: an empty one, or the placeholder the home server's Navidrome lists a song under (the sync keeps it as is). */
export const NO_ALBUM = `LOWER(t.album) IN ('', '[unknown album]')`;
/** An artist worth looking up: not empty and not Navidrome's placeholder. */
export const HAS_ARTIST = `t.artist <> '' AND LOWER(t.artist) <> '[unknown artist]'`;

const UNCHECKED =
  `t.family_id = ? AND t.deleted = 0 AND ${NO_ALBUM} AND ${HAS_ARTIST} AND t.title <> ''
   AND NOT EXISTS (SELECT 1 FROM album_suggestions s WHERE s.family_id = t.family_id AND s.track_id = t.id)`;

/** Songs with an artist and no album that were never looked at. */
async function unchecked(env: Env, familyId: string, limit: number): Promise<SongRow[]> {
  const r = await env.DB.prepare(
    `SELECT t.id, t.source, t.title, t.artist, t.album, t.track_no, t.duration FROM tracks t WHERE ${UNCHECKED} ORDER BY t.updated_at LIMIT ?`,
  ).bind(familyId, limit).all<SongRow>();
  return r.results;
}

export async function autoApplyOn(db: D1Database, familyId: string): Promise<boolean> {
  const r = await db.prepare("SELECT auto_apply FROM album_settings WHERE family_id = ?").bind(familyId).first<{ auto_apply: number }>();
  return !!r?.auto_apply;
}

export interface NightlyResult { checked: number; saved: number; applied: number; filesWritten: number; remaining: number; note: string }

/**
 * One slice of the nightly run for every family: looks up `limit` unchecked songs per family and saves what it found.
 * With auto-apply on, a guess that passes `autoApplicable` is written (file tags first, like a manual edit).
 */
export async function nightlyAlbums(env: Env, limit: number): Promise<NightlyResult> {
  const take = Math.min(Math.max(Math.floor(limit) || 1, 1), 5);
  const fams = await env.DB.prepare("SELECT id FROM families").all<{ id: string }>();
  const out: NightlyResult = { checked: 0, saved: 0, applied: 0, filesWritten: 0, remaining: 0, note: "" };
  for (const { id: familyId } of fams.results) {
    const rows = await unchecked(env, familyId, take);
    if (rows.length === 0) continue;
    const { guesses, soundNote } = await suggestFor(env, rows);
    if (soundNote) out.note = soundNote;
    const auto = await autoApplyOn(env.DB, familyId);
    const now = Date.now();
    for (const row of rows) {
      out.checked++;
      const g = guesses.get(row.id) ?? [];
      const top = g[0];
      if (auto && autoApplicable(top)) {
        try {
          let wrote = 0;
          const r = await editTrack(env.DB, familyId, row.id, { album: top.album }, async (plan) => {
            if (plan.source === "nas") wrote = (await homeEdit(env, [{ kind: "song", match: plan.before, set: plan.applied }])).written;
          });
          if (r) {
            out.applied++;
            out.filesWritten += wrote;
            continue; // the song has an album now: no row to keep
          }
        } catch (e) {
          if (!(e instanceof HomeError)) throw e;
          out.note = e.message; // the files could not be written: keep the guess for the owner instead
        }
      }
      await env.DB.prepare("INSERT OR REPLACE INTO album_suggestions (family_id, track_id, guesses, status, checked_at) VALUES (?, ?, ?, ?, ?)")
        .bind(familyId, row.id, JSON.stringify(g), g.length ? "open" : "none", now).run();
      if (g.length) out.saved++;
    }
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tracks t WHERE ${UNCHECKED}`).bind(familyId).first<{ n: number }>();
    out.remaining += left?.n ?? 0;
  }
  return out;
}

export interface SavedSuggestion { id: string; title: string; artist: string; duration: number; guesses: AlbumGuess[] }

/** The open suggestions of a family, for songs that still have no album. */
export async function savedSuggestions(db: D1Database, familyId: string): Promise<SavedSuggestion[]> {
  const r = await db.prepare(
    `SELECT t.id, t.title, t.artist, t.duration, s.guesses FROM album_suggestions s JOIN tracks t ON t.id = s.track_id AND t.family_id = s.family_id
     WHERE s.family_id = ? AND s.status = 'open' AND t.deleted = 0 AND ${NO_ALBUM} ORDER BY t.artist, t.title LIMIT 500`,
  ).bind(familyId).all<{ id: string; title: string; artist: string; duration: number; guesses: string }>();
  return r.results.flatMap((x) => {
    try {
      return [{ id: x.id, title: x.title, artist: x.artist, duration: x.duration, guesses: JSON.parse(x.guesses) as AlbumGuess[] }];
    } catch {
      return [];
    }
  });
}
