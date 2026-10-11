/**
 * Car-sized covers. Android Auto shows many covers at once on a slow link, so `GET /api/art/:id?w=car` serves a
 * 512 px JPEG made from the original with the Cloudflare Images binding and cached in R2 next to the family's files.
 * The cache key includes the original's etag, so a replaced cover is resized again. Returns null when it cannot
 * resize (no binding, missing original, or an error): the caller then serves the original as before.
 */

const SIZE = 512;
const QUALITY = 80;

export async function carArt(env: Env, familyId: string, trackId: string, artKey: string): Promise<Response | null> {
  if (!env.IMAGES) return null;
  const headers = { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" };
  try {
    const original = await env.MUSIC.head(artKey);
    if (!original) return null;
    const key = `families/${familyId}/art-car/${trackId}-${original.etag}.jpg`;
    const cached = await env.MUSIC.get(key);
    if (cached) return new Response(cached.body, { headers });

    const src = await env.MUSIC.get(artKey);
    if (!src) return null;
    const out = await env.IMAGES.input(src.body).transform({ width: SIZE, height: SIZE, fit: "cover" }).output({ format: "image/jpeg", quality: QUALITY });
    const bytes = await out.response().arrayBuffer();
    await env.MUSIC.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
    return new Response(bytes, { headers });
  } catch (e) {
    console.warn("car art failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
