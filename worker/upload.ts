import { parseBuffer } from "music-metadata";
import { findAlbumArt } from "./artwork";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Stores an uploaded audio file in R2 and indexes it in D1. Capped by the Worker request body limit (100 MB).
 * A file identical to one already in the family library (same SHA-256) is not stored again; the existing track id comes back.
 */
export async function ingest(env: Env, familyId: string, file: File): Promise<{ id: string; duplicate: boolean }> {
  const buf = await file.arrayBuffer();
  const hash = hex(await crypto.subtle.digest("SHA-256", buf));
  const existing = await env.DB.prepare("SELECT id FROM tracks WHERE family_id = ? AND content_hash = ? AND deleted = 0 LIMIT 1")
    .bind(familyId, hash).first<{ id: string }>();
  if (existing) return { id: existing.id, duplicate: true };
  const id = crypto.randomUUID();
  const key = `families/${familyId}/tracks/${id}`;
  const meta = await parseBuffer(new Uint8Array(buf), { mimeType: file.type || undefined }, { duration: true }).catch(() => null);
  const common = meta?.common;
  const mime = file.type || "audio/mpeg";
  await env.MUSIC.put(key, buf, { httpMetadata: { contentType: mime } });

  let artKey: string | null = null;
  const title = common?.title || file.name.replace(/\.[^.]+$/, "");
  let tried = 0;
  let pic: { data: Uint8Array | ArrayBuffer; format: string } | undefined = common?.picture?.[0];
  if (!pic) {
    // No embedded cover: look one up online (best effort).
    tried = 1;
    const found = await findAlbumArt(common?.artist ?? "", common?.album ?? "", title).catch(() => null);
    if (found) pic = { data: found.data, format: found.type };
  }
  if (pic) {
    artKey = `families/${familyId}/art/${id}`;
    await env.MUSIC.put(artKey, pic.data, { httpMetadata: { contentType: pic.format } });
  }
  await env.DB.prepare(
    "INSERT INTO tracks (id, family_id, source, source_key, title, artist, album, duration, track_no, art_key, size, etag, mime, updated_at, content_hash, art_tried) " +
      "VALUES (?, ?, 'r2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id, familyId, key, title, common?.artist ?? "", common?.album ?? "", meta?.format.duration ?? 0, common?.track.no ?? 0,
    artKey, buf.byteLength, id, mime, Date.now(), hash, tried,
  ).run();
  return { id, duplicate: false };
}
