import { Hono } from "hono";
import { verifyIdToken, type User } from "./auth";
import { createFamily, createInvite, familyInfo, joinWithInvite, membershipOf, removeMember, type Membership } from "./family";
import { findAlbumArt, findArtistImage } from "./artwork";
import { delta, savePlaylist } from "./library";
import { ingest } from "./upload";

type Vars = { user: User; family: Membership };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Auth: Authorization bearer token. Media URLs (stream/art) also accept ?access_token= because
// <audio>/<img> elements can't send headers.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/app/android/")) return next(); // APK download: the app is not signed in yet on first install
  const url = new URL(c.req.url);
  const mediaPath = /^\/api\/(stream|art|artist-art)\//.test(url.pathname);
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

/** Routes that need the caller to be in a family. */
const needFamily = async (c: import("hono").Context<{ Bindings: Env; Variables: Vars }>, next: () => Promise<void>) => {
  const m = await membershipOf(c.env.DB, c.get("user").uid);
  if (!m) return c.json({ error: "no family" }, 403);
  c.set("family", m);
  await next();
};
for (const p of ["/api/library", "/api/playlists/*", "/api/upload", "/api/tracks/*", "/api/stream/*", "/api/art/*", "/api/artist-art/*", "/api/family/invites"]) {
  app.use(p, needFamily);
}

// ---- Family -------------------------------------------------------------------------------

app.get("/api/family", async (c) => {
  const m = await membershipOf(c.env.DB, c.get("user").uid);
  return m ? c.json(await familyInfo(c.env.DB, m)) : c.json({ error: "no family" }, 404);
});

app.post("/api/family", async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  const clean = name?.trim().slice(0, 60);
  if (!clean) return c.json({ error: "name required" }, 400);
  const m = await createFamily(c.env.DB, c.get("user"), clean);
  return m ? c.json(await familyInfo(c.env.DB, m), 201) : c.json({ error: "already in a family" }, 409);
});

app.post("/api/family/invites", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  return c.json(await createInvite(c.env.DB, c.get("family").familyId, c.get("user").uid), 201);
});

app.post("/api/family/join", async (c) => {
  const { code } = await c.req.json<{ code?: string }>();
  if (!code) return c.json({ error: "code required" }, 400);
  const m = await joinWithInvite(c.env.DB, c.get("user"), code);
  return m ? c.json(await familyInfo(c.env.DB, m)) : c.json({ error: "invalid or expired code, or already in a family" }, 400);
});

/** Leave the family (self) or, as owner, remove another member. */
app.delete("/api/family/members/:uid", async (c) => {
  const me = c.get("user");
  const target = c.req.param("uid");
  const m = await membershipOf(c.env.DB, me.uid);
  if (!m) return c.json({ error: "no family" }, 403);
  if (target !== me.uid) {
    const other = await membershipOf(c.env.DB, target);
    if (m.role !== "owner" || other?.familyId !== m.familyId) return c.json({ error: "forbidden" }, 403);
  }
  await removeMember(c.env, target);
  return c.json({ ok: true });
});

/** Account deletion (App Store / Play requirement): removes the caller from their family and deletes their playlists. */
app.delete("/api/account", async (c) => {
  await removeMember(c.env, c.get("user").uid);
  return c.json({ ok: true });
});

// ---- Library ------------------------------------------------------------------------------

app.get("/api/library", async (c) => {
  const since = Number(c.req.query("since") ?? 0) || 0;
  return c.json(await delta(c.env.DB, c.get("family").familyId, c.get("user").uid, since));
});

app.put("/api/playlists/:id", async (c) => {
  const body = await c.req.json<{ name?: string; shared?: boolean; trackIds?: string[] }>();
  if (!body.name || !Array.isArray(body.trackIds)) return c.json({ error: "bad request" }, 400);
  const ok = await savePlaylist(c.env.DB, c.get("family").familyId, c.get("user").uid, c.req.param("id"), body.name, !!body.shared, body.trackIds);
  return ok ? c.json({ ok: true }) : c.json({ error: "forbidden" }, 403);
});

app.delete("/api/playlists/:id", async (c) => {
  await c.env.DB.prepare("UPDATE playlists SET deleted = 1, updated_at = ? WHERE id = ? AND owner_uid = ? AND family_id = ?")
    .bind(Date.now(), c.req.param("id"), c.get("user").uid, c.get("family").familyId).run();
  return c.json({ ok: true });
});

app.post("/api/upload", async (c) => {
  const form = await c.req.formData();
  const ids: string[] = [];
  let duplicates = 0;
  for (const f of form.getAll("file")) {
    if (typeof f === "string") continue;
    const r = await ingest(c.env, c.get("family").familyId, f);
    ids.push(r.id);
    if (r.duplicate) duplicates++;
  }
  return c.json({ ids, duplicates });
});

app.delete("/api/tracks/:id", async (c) => {
  const fam = c.get("family").familyId;
  const row = await c.env.DB.prepare("SELECT source, source_key, art_key FROM tracks WHERE id = ? AND family_id = ? AND deleted = 0")
    .bind(c.req.param("id"), fam).first<{ source: string; source_key: string; art_key: string | null }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.source === "r2") await c.env.MUSIC.delete(row.art_key ? [row.source_key, row.art_key] : [row.source_key]);
  await c.env.DB.prepare("UPDATE tracks SET deleted = 1, art_key = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), c.req.param("id")).run();
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
  const row = await c.env.DB.prepare("SELECT source, source_key FROM tracks WHERE id = ? AND family_id = ? AND deleted = 0")
    .bind(c.req.param("id"), c.get("family").familyId).first<{ source: string; source_key: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.source === "r2") return serveR2(c.env.MUSIC, row.source_key, c.req.raw);
  return c.json({ error: "nas not configured" }, 501); // NAS proxy: build step 5
});

/** Looks up missing album covers online for up to 10 tracks per call; the client repeats until `remaining` is 0. */
app.post("/api/art/fetch", async (c) => {
  const fam = c.get("family").familyId;
  const missing = "family_id = ? AND source = 'r2' AND deleted = 0 AND art_key IS NULL AND art_tried = 0";
  const rows = await c.env.DB.prepare(`SELECT id, title, artist, album FROM tracks WHERE ${missing} LIMIT 10`)
    .bind(fam).all<{ id: string; title: string; artist: string; album: string }>();
  let updated = 0;
  for (const r of rows.results) {
    const img = await findAlbumArt(r.artist, r.album, r.title).catch(() => null);
    if (img) {
      const key = `families/${fam}/art/${r.id}`;
      await c.env.MUSIC.put(key, img.data, { httpMetadata: { contentType: img.type } });
      await c.env.DB.prepare("UPDATE tracks SET art_key = ?, art_tried = 1, updated_at = ? WHERE id = ?").bind(key, Date.now(), r.id).run();
      updated++;
    } else {
      await c.env.DB.prepare("UPDATE tracks SET art_tried = 1 WHERE id = ?").bind(r.id).run();
    }
  }
  const left = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${missing}`).bind(fam).first<{ n: number }>();
  return c.json({ updated, remaining: left?.n ?? 0 });
});

/** Artist picture, fetched on first request and cached in R2 (an empty object remembers a miss). */
app.get("/api/artist-art/:name", async (c) => {
  const name = c.req.param("name").trim().slice(0, 100);
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  if (!slug) return c.json({ error: "not found" }, 404);
  const key = `families/${c.get("family").familyId}/artist/${slug}`;
  let head = await c.env.MUSIC.head(key);
  if (!head) {
    const img = await findArtistImage(name).catch(() => null);
    head = await c.env.MUSIC.put(key, img?.data ?? new ArrayBuffer(0), { httpMetadata: { contentType: img?.type ?? "application/octet-stream" } });
  }
  if (head.size === 0) return c.json({ error: "not found" }, 404);
  return serveR2(c.env.MUSIC, key, c.req.raw, { "Cache-Control": "private, max-age=86400" });
});

app.get("/api/art/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT art_key FROM tracks WHERE id = ? AND family_id = ?")
    .bind(c.req.param("id"), c.get("family").familyId).first<{ art_key: string | null }>();
  if (!row?.art_key) return c.json({ error: "not found" }, 404);
  return serveR2(c.env.MUSIC, row.art_key, c.req.raw, { "Cache-Control": "private, max-age=86400" });
});

// ---- App releases (published by scripts/android-release.mjs) ------------------------------

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
