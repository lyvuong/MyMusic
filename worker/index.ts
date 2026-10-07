import { Hono } from "hono";
import { verifyIdToken, type User } from "./auth";
import { delta, savePlaylist } from "./library";
import { ingest } from "./upload";

type Vars = { user: User };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Auth: Authorization bearer token. Media URLs (stream/art) also accept ?access_token= because
// <audio>/<img> elements can't send headers.
app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  const mediaPath = /^\/api\/(stream|art)\//.test(url.pathname);
  const header = c.req.header("Authorization")?.replace(/^Bearer /, "");
  const token = header ?? (mediaPath ? url.searchParams.get("access_token") : null);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    c.set("user", await verifyIdToken(token, c.env));
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/api/library", async (c) => {
  const since = Number(c.req.query("since") ?? 0) || 0;
  return c.json(await delta(c.env.DB, c.get("user").uid, since));
});

app.put("/api/playlists/:id", async (c) => {
  const body = await c.req.json<{ name?: string; trackIds?: string[] }>();
  if (!body.name || !Array.isArray(body.trackIds)) return c.json({ error: "bad request" }, 400);
  const ok = await savePlaylist(c.env.DB, c.get("user").uid, c.req.param("id"), body.name, body.trackIds);
  return ok ? c.json({ ok: true }) : c.json({ error: "forbidden" }, 403);
});

app.delete("/api/playlists/:id", async (c) => {
  await c.env.DB.prepare("UPDATE playlists SET deleted = 1, updated_at = ? WHERE id = ? AND owner = ?")
    .bind(Date.now(), c.req.param("id"), c.get("user").uid).run();
  return c.json({ ok: true });
});

app.post("/api/upload", async (c) => {
  const form = await c.req.formData();
  const ids: string[] = [];
  for (const f of form.getAll("file")) if (typeof f !== "string") ids.push(await ingest(c.env, f));
  return c.json({ ids });
});

app.delete("/api/tracks/:id", async (c) => {
  await c.env.DB.prepare("UPDATE tracks SET deleted = 1, updated_at = ? WHERE id = ?").bind(Date.now(), c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Serves an R2 object honouring Range, for seeking and resumable downloads. */
async function serveR2(bucket: R2Bucket, key: string, req: Request, extra: HeadersInit = {}) {
  const obj = await bucket.get(key, { range: req.headers });
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers(extra);
  obj.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", obj.httpEtag);
  const r = obj.range as { offset?: number; length?: number } | undefined;
  if (r && r.offset !== undefined && r.length !== undefined) {
    headers.set("Content-Range", `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(r.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

app.get("/api/stream/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT source, source_key FROM tracks WHERE id = ? AND deleted = 0")
    .bind(c.req.param("id")).first<{ source: string; source_key: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.source === "r2") return serveR2(c.env.MUSIC, row.source_key, c.req.raw);
  return c.json({ error: "nas not configured" }, 501); // NAS proxy: build step 5
});

app.get("/api/art/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT art_key FROM tracks WHERE id = ?").bind(c.req.param("id")).first<{ art_key: string | null }>();
  if (!row?.art_key) return c.json({ error: "not found" }, 404);
  return serveR2(c.env.MUSIC, row.art_key, c.req.raw, { "Cache-Control": "private, max-age=86400" });
});

// App releases (published by scripts/android-release.mjs).
app.get("/api/app/android/latest", async (c) => {
  const obj = await c.env.RELEASES.get("android/latest.json");
  if (!obj) return c.json({ error: "none" }, 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
});
app.get("/api/app/android/:file", (c) => {
  const file = c.req.param("file");
  if (!/^mymusic-\d+-[a-z0-9_-]+\.apk$/.test(file)) return c.json({ error: "bad file" }, 400);
  return serveR2(c.env.RELEASES, `android/${file}`, c.req.raw);
});

export default app;
