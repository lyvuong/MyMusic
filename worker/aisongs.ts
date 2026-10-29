/**
 * Review of the AI badge: sets or clears it for many songs at once, and asks YouTube again about songs that were added
 * from a YouTube link (the link is kept in youtube_sources).
 */
import type { AiRecheck } from "../shared/types";
import { clearLibraryCache } from "./browse";
import { homeYoutubeInfo } from "./home";

const IN_CHUNK = 90; // D1 allows 100 bound parameters per query

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Remembers the link a song is being added from. */
export async function rememberSource(db: D1Database, familyId: string, url: string, title: string, artist: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO youtube_sources (family_id, url, title, artist, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(familyId, url, title.normalize("NFC"), artist.normalize("NFC"), Date.now()).run();
}

/** The ids of library songs whose YouTube link is known (so YouTube can be asked about them). */
export async function songsWithSource(db: D1Database, familyId: string): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT t.id FROM tracks t WHERE t.family_id = ? AND t.deleted = 0 AND EXISTS " +
      "(SELECT 1 FROM youtube_sources y WHERE y.family_id = t.family_id AND y.title = t.title AND y.artist = t.artist)",
  ).bind(familyId).all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

/** Sets or clears the AI badge of the given songs; resolves to how many really changed. No file is touched. */
export async function setAi(db: D1Database, familyId: string, ids: string[], ai: boolean): Promise<number> {
  const now = Date.now();
  let changed = 0;
  for (const part of chunks(ids, IN_CHUNK)) {
    const r = await db.prepare(
      `UPDATE tracks SET ai = ?, updated_at = ? WHERE family_id = ? AND deleted = 0 AND ai = ? AND id IN (${part.map(() => "?").join(",")})`,
    ).bind(ai ? 1 : 0, now, familyId, ai ? 0 : 1, ...part).run();
    changed += r.meta.changes ?? 0;
  }
  if (changed) await clearLibraryCache(db, familyId);
  return changed;
}

/** Asks YouTube again about each song (one after the other): whether the video is labelled as made with AI, or the description hints at it. */
export async function recheckAi(env: Env, familyId: string, ids: string[]): Promise<AiRecheck[]> {
  const out: AiRecheck[] = [];
  for (const id of ids) {
    const row = await env.DB.prepare(
      "SELECT y.url FROM tracks t JOIN youtube_sources y ON y.family_id = t.family_id AND y.title = t.title AND y.artist = t.artist " +
        "WHERE t.id = ? AND t.family_id = ? AND t.deleted = 0 ORDER BY y.created_at DESC LIMIT 1",
    ).bind(id, familyId).first<{ url: string }>();
    if (!row) {
      out.push({ id, label: false, hint: false, error: "No YouTube link is known for this song." });
      continue;
    }
    try {
      const info = await homeYoutubeInfo(env, row.url);
      out.push({ id, label: info.aiLabel, hint: info.aiHint });
    } catch (e) {
      out.push({ id, label: false, hint: false, error: e instanceof Error ? e.message : "Could not read the video" });
    }
  }
  return out;
}
