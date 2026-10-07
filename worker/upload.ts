import { parseBuffer } from "music-metadata";

/** Stores an uploaded audio file in R2 and indexes it in D1. Capped by the Worker request body limit (100 MB). */
export async function ingest(env: Env, familyId: string, file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const id = crypto.randomUUID();
  const key = `families/${familyId}/tracks/${id}`;
  const meta = await parseBuffer(new Uint8Array(buf), { mimeType: file.type || undefined }, { duration: true }).catch(() => null);
  const common = meta?.common;
  const mime = file.type || "audio/mpeg";
  await env.MUSIC.put(key, buf, { httpMetadata: { contentType: mime } });

  let artKey: string | null = null;
  const pic = common?.picture?.[0];
  if (pic) {
    artKey = `families/${familyId}/art/${id}`;
    await env.MUSIC.put(artKey, pic.data, { httpMetadata: { contentType: pic.format } });
  }
  const title = common?.title || file.name.replace(/\.[^.]+$/, "");
  await env.DB.prepare(
    "INSERT INTO tracks (id, family_id, source, source_key, title, artist, album, duration, track_no, art_key, size, etag, mime, updated_at) " +
      "VALUES (?, ?, 'r2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id, familyId, key, title, common?.artist ?? "", common?.album ?? "", meta?.format.duration ?? 0, common?.track.no ?? 0,
    artKey, buf.byteLength, id, mime, Date.now(),
  ).run();
  return id;
}
