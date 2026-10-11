import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { signedQuery, verifySigned } from "./cast";
import { verifyIdToken, type User } from "./auth";
import { createFamily, createInvite, familyInfo, joinWithInvite, membershipOf, removeMember, type Membership } from "./family";
import { findAlbumArt, findArtistImage } from "./artwork";
import { cleanName, delta, editTrack, renameGroup, savePlaylist } from "./library";
import { agentKeyOk, beginRun, enqueueYoutube, failRun, finishRun, getRun, goneFromServer, listRuns, resetRunning, startAgentRun, updateProgress } from "./beets";
import { dispatchQueued } from "./ytqueue";
import { HomeError, homeConfigured, homeCover, homeEdit, homeStartJob, homeStatus, homeYoutubeInfo, type TagOp } from "./home";
import { finishSync, nasEnabled, proxyCover, proxyStream, scanning, startScan, syncPage } from "./nas";
import { getRatings, setRating } from "./ratings";
import { recordPlays, popular } from "./plays";
import { buildMixesFor, buildMixSlice, getMixes } from "./mixes";
import { carArt } from "./carart";
import { suggest, SuggestError } from "./suggest";
import { ingest } from "./upload";

type Vars = { user: User; family: Membership };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Anything a route does not catch: say what went wrong instead of a bare 500, and keep the details in the logs.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${c.req.method} ${c.req.path} failed:`, msg);
  if (/row write limit|exceeded D1's/i.test(msg)) {
    return c.json({ error: "The database's daily write limit was reached. It resets at midnight UTC." }, 503);
  }
  return c.json({ error: `Server error: ${msg.split("\n")[0]!.slice(0, 160)}` }, 500);
});

// Cast devices fetch media themselves (cross-origin, with Range): answer CORS before the auth check.
app.use("/api/stream/*", cors({ origin: "*", allowHeaders: ["Range", "Authorization"], exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"] }));
app.use("/api/art/*", cors({ origin: "*", allowHeaders: ["Range", "Authorization"], exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"] }));

// Auth: Authorization bearer token. Media URLs (stream/art) also accept ?access_token= because
// <audio>/<img> elements can't send headers.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/app/android/")) return next(); // APK download: the app is not signed in yet on first install
  if (c.req.path.startsWith("/api/beets/agent/")) return next(); // the home-server script; authenticates with BEETS_AGENT_KEY
  const url = new URL(c.req.url);
  const mediaPath = /^\/api\/(stream|art|artist-art)\//.test(url.pathname);
  // A signed URL (handed out for casting) stands in for the login, for that one track's audio or cover.
  const sig = mediaPath ? url.searchParams.get("sig") : null;
  if (sig) {
    const m = /^\/api\/(stream|art)\/([^/]+)$/.exec(url.pathname);
    const fam = url.searchParams.get("fam") ?? "";
    if (m && fam && await verifySigned(c.env.DB, m[1]!, m[2]!, fam, Number(url.searchParams.get("exp")), sig)) {
      c.set("family", { familyId: fam, role: "member" });
      return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  }
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
  if (c.get("family")) return next(); // already set from a signed media URL
  const m = await membershipOf(c.env.DB, c.get("user").uid);
  if (!m) return c.json({ error: "no family" }, 403);
  c.set("family", m);
  await next();
};
for (const p of ["/api/library", "/api/playlists/*", "/api/upload", "/api/library/*", "/api/tracks/*", "/api/stream/*", "/api/art/*", "/api/artist-art/*", "/api/nas/*", "/api/beets/run", "/api/beets/enrich", "/api/beets/runs", "/api/beets/youtube", "/api/beets/youtube/*", "/api/server/status", "/api/family/invites", "/api/ratings", "/api/ratings/*", "/api/suggest", "/api/plays", "/api/popular", "/api/mixes", "/api/mixes/*", "/api/art-urls", "/api/cast/*"]) {
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

// ---- Plays, popularity and the nightly mixes ----------------------------------------------

/** Plays to record: `[{ trackId, at }]`, `at` in epoch ms; the app sends them in batches after listening. */
app.post("/api/plays", async (c) => {
  const b = await c.req.json<{ plays?: { trackId: string; at: number }[] }>().catch(() => null);
  if (!Array.isArray(b?.plays)) return c.json({ error: "bad request" }, 400);
  return c.json({ saved: await recordPlays(c.env.DB, c.get("family").familyId, c.get("user").uid, b!.plays) });
});

/** The family's most played songs lately, most played first. */
app.get("/api/popular", async (c) => c.json({ tracks: await popular(c.env.DB, c.get("family").familyId) }));

/** The caller's AI mixes (one per time of day), built overnight. Empty until the first night run. */
app.get("/api/mixes", async (c) => c.json({ mixes: await getMixes(c.env.DB, c.get("user").uid) }));

/** Builds the caller's own mixes now instead of waiting for the night run (about half a minute). */
app.post("/api/mixes/refresh", async (c) => {
  const saved = await buildMixesFor(c.env, c.get("family").familyId, c.get("user").uid, true);
  return c.json({ saved });
});

/**
 * Signed cover URLs, sized for the car (`?w=car`), for up to 500 tracks. Android Auto's image loader cannot send the
 * login token, so every URL carries its own proof (valid 12 hours).
 */
app.post("/api/art-urls", async (c) => {
  const b = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = Array.isArray(b?.ids) ? [...new Set((b!.ids as unknown[]).filter((x): x is string => typeof x === "string"))].slice(0, 500) : [];
  if (ids.length === 0) return c.json({ error: "bad request" }, 400);
  const fam = c.get("family").familyId;
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const r = await c.env.DB.prepare(`SELECT id FROM tracks WHERE family_id = ? AND deleted = 0 AND art_key IS NOT NULL AND id IN (${part.map(() => "?").join(",")})`)
      .bind(fam, ...part).all<{ id: string }>();
    for (const row of r.results) have.add(row.id);
  }
  const origin = new URL(c.req.url).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const urls: Record<string, string> = {};
  for (const id of have) urls[id] = `${origin}/api/art/${id}?w=car&${await signedQuery(c.env.DB, "art", id, fam)}`;
  return c.json({ urls, exp });
});

// ---- Ratings and AI suggestions -----------------------------------------------------------

app.get("/api/ratings", async (c) => c.json({ ratings: await getRatings(c.env.DB, c.get("user").uid) }));

/** Sets the caller's rating for a song: 1-5 stars, or 0 to clear. */
app.put("/api/ratings/:trackId", async (c) => {
  const { rating } = await c.req.json<{ rating?: number }>().catch(() => ({ rating: undefined }));
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 0 || rating > 5) return c.json({ error: "rating must be 0-5" }, 400);
  const ok = await setRating(c.env.DB, c.get("family").familyId, c.get("user").uid, c.req.param("trackId"), rating);
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

/** A playlist and new-music ideas from the caller's ratings, optionally steered by a mood or occasion. */
app.post("/api/suggest", async (c) => {
  const { prompt } = await c.req.json<{ prompt?: string }>().catch(() => ({ prompt: undefined }));
  try {
    return c.json(await suggest(c.env, c.get("family").familyId, c.get("user").uid, (prompt ?? "").trim()));
  } catch (e) {
    if (e instanceof SuggestError) return c.json({ error: e.message }, e.status);
    throw e;
  }
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

/** Edits a song's title, artist, album and/or track number. */
app.patch("/api/tracks/:id", async (c) => {
  const b = await c.req.json<{ title?: unknown; artist?: unknown; album?: unknown; trackNo?: unknown; ai?: unknown }>().catch(() => null);
  if (!b) return c.json({ error: "bad request" }, 400);
  const edit: { title?: string; artist?: string; album?: string; trackNo?: number; ai?: boolean } = {};
  if (typeof b.ai === "boolean") edit.ai = b.ai;
  if (b.title !== undefined) {
    edit.title = cleanName(b.title);
    if (!edit.title) return c.json({ error: "title cannot be empty" }, 400);
  }
  if (b.artist !== undefined) edit.artist = cleanName(b.artist);
  if (b.album !== undefined) edit.album = cleanName(b.album);
  if (b.trackNo !== undefined) {
    const n = Number(b.trackNo);
    if (!Number.isInteger(n) || n < 0 || n > 9999) return c.json({ error: "bad track number" }, 400);
    edit.trackNo = n;
  }
  // The file's tags are written on the home server first (NAS songs only); if that fails nothing changes here.
  let files: Awaited<ReturnType<typeof homeEdit>> | null = null;
  try {
    const r = await editTrack(c.env.DB, c.get("family").familyId, c.req.param("id"), edit, async (plan) => {
      if (plan.source === "nas") files = await homeEdit(c.env, [{ kind: "song", match: plan.before, set: plan.applied }]);
    });
    if (!r) return c.json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof HomeError) return c.json({ error: e.message }, 502);
    throw e;
  }
  return c.json(await afterFileEdit(c.env, c.executionCtx, files));
});

/**
 * Renames an artist or album everywhere in the family library. If the new name already exists the two are merged
 * (all songs end up under it). `from` is the current name exactly as listed.
 */
app.post("/api/library/rename", async (c) => {
  const b = await c.req.json<{ kind?: string; from?: unknown; to?: unknown }>().catch(() => null);
  if (!b || (b.kind !== "artist" && b.kind !== "album") || typeof b.from !== "string" || !b.from) return c.json({ error: "bad request" }, 400);
  const to = cleanName(b.to);
  if (!to) return c.json({ error: "name cannot be empty" }, 400);
  let files: Awaited<ReturnType<typeof homeEdit>> | null = null;
  const kind = b.kind;
  const from = b.from;
  try {
    const r = await renameGroup(c.env.DB, c.get("family").familyId, kind, from, to, async (plan) => {
      if (plan.nas > 0) files = await homeEdit(c.env, [{ kind, from, to: plan.target } satisfies TagOp]);
    });
    if (r.updated === 0) return c.json({ error: "nothing to rename" }, 404);
    return c.json({ updated: r.updated, ...(await afterFileEdit(c.env, c.executionCtx, files)) });
  } catch (e) {
    if (e instanceof HomeError) return c.json({ error: e.message }, 502);
    throw e;
  }
});

/**
 * Sets the cover of an album from an uploaded JPEG (the web app scales it down first). The image goes into the album's
 * folders on the home server as cover.jpg and into R2, so it shows at once; Navidrome picks the file up on the next
 * scan and the next NAS sync replaces the R2 copy with Navidrome's.
 */
app.post("/api/library/cover", async (c) => {
  const b = await c.req.json<{ album?: unknown; image?: unknown }>().catch(() => null);
  const album = cleanName(b?.album);
  const image = typeof b?.image === "string" ? b.image : "";
  if (!b || !album || !image) return c.json({ error: "bad request" }, 400);
  if (image.length > 5_500_000) return c.json({ error: "The image is too large." }, 413);
  if (!image.startsWith("/9j/")) return c.json({ error: "The image must be a JPEG." }, 415);
  const fam = c.get("family").familyId;
  const bytes = Uint8Array.from(atob(image), (ch) => ch.charCodeAt(0));
  const rows = await c.env.DB.prepare("SELECT source, COUNT(*) AS n FROM tracks WHERE family_id = ? AND album = ? AND deleted = 0 GROUP BY source")
    .bind(fam, album).all<{ source: string; n: number }>();
  const total = rows.results.reduce((s, r) => s + r.n, 0);
  if (total === 0) return c.json({ error: "album not found" }, 404);
  let files: Awaited<ReturnType<typeof homeCover>> | null = null;
  if (rows.results.some((r) => r.source === "nas")) {
    try {
      files = await homeCover(c.env, album, image);
    } catch (e) {
      if (e instanceof HomeError) return c.json({ error: e.message }, 502);
      throw e;
    }
    if (files.written === 0 && !files.embedded) {
      return c.json({ error: "None of this album's files were found on the server." }, 409);
    }
  }
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  const key = `families/${fam}/art/cover-${[...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  await c.env.MUSIC.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await c.env.DB.prepare("UPDATE tracks SET art_key = ?, art_tried = 1, updated_at = ? WHERE family_id = ? AND album = ? AND deleted = 0")
    .bind(key, Date.now(), fam, album).run();
  if (files && nasEnabled(c.env)) c.executionCtx.waitUntil(startScan(c.env).catch(() => undefined));
  const notes: string[] = [];
  if (files?.embedded) notes.push(`Some songs share a folder with other albums, so the cover was embedded in ${files.embedded} file${files.embedded === 1 ? "" : "s"} instead of saved as a folder image.`);
  if (files?.shadowed?.length) notes.push("Navidrome may keep showing the folder's own cover image for those songs until it is removed.");
  const warning = notes.join(" ");
  return c.json({ ok: true, filesUpdated: !!files, warning });
});

/** After tags were written on the server: let Navidrome re-read them and tell the user about songs that were not found. */
async function afterFileEdit(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, files: { written: number; skipped: string[]; missing?: string[] } | null) {
  if (!files) return { ok: true, filesUpdated: false, warning: "" };
  if (nasEnabled(env)) ctx.waitUntil(startScan(env).catch(() => undefined));
  const notes: string[] = [];
  if (files.skipped.length) {
    notes.push(`${files.skipped.length} song${files.skipped.length === 1 ? " was" : "s were"} not found in the file library, so only the app changed for ${files.skipped.length === 1 ? "it" : "them"}.`);
  }
  const gone = files.missing?.length ?? 0;
  if (gone) {
    notes.push(`${gone} file${gone === 1 ? " is" : "s are"} missing on the server disk (run "beet update" there to clean the library), so only the library entry changed.`);
  }
  const warning = notes.join(" ");
  return { ok: true, filesUpdated: files.written > 0, warning };
}

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
  if (!nasEnabled(c.env)) return c.json({ error: "nas not configured" }, 501);
  return proxyStream(c.env, row.source_key, c.req.raw);
});

/**
 * Signed, absolute stream and cover URLs for a cast device (valid for 12 hours), for up to 500 tracks of the caller's
 * family. The cast device fetches them directly, so they carry their own proof instead of the login token.
 */
app.post("/api/cast/media", async (c) => {
  const b = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = Array.isArray(b?.ids) ? [...new Set((b!.ids as unknown[]).filter((x): x is string => typeof x === "string"))].slice(0, 500) : [];
  if (ids.length === 0) return c.json({ error: "bad request" }, 400);
  const fam = c.get("family").familyId;
  const rows: { id: string; art_key: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const r = await c.env.DB.prepare(`SELECT id, art_key FROM tracks WHERE family_id = ? AND deleted = 0 AND id IN (${part.map(() => "?").join(",")})`)
      .bind(fam, ...part).all<{ id: string; art_key: string | null }>();
    rows.push(...r.results);
  }
  const origin = new URL(c.req.url).origin;
  const items: Record<string, { stream: string; art: string | null }> = {};
  for (const r of rows) {
    items[r.id] = {
      stream: `${origin}/api/stream/${r.id}?${await signedQuery(c.env.DB, "stream", r.id, fam)}`,
      art: r.art_key ? `${origin}/api/art/${r.id}?${await signedQuery(c.env.DB, "art", r.id, fam)}` : null,
    };
  }
  return c.json({ items });
});

/** Imports the NAS library page by page (owner only); the client repeats with `next` until `done`. */
app.post("/api/nas/sync", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  if (!nasEnabled(c.env)) return c.json({ error: "NAS is not configured" }, 501);
  const b = await c.req.json<{ offset?: number; finish?: boolean; ids?: unknown }>().catch(() => ({}) as { offset?: number; finish?: boolean; ids?: unknown });
  const fam = c.get("family").familyId;
  try {
    if (b.finish) {
      // The last call: every id the NAS listed, so songs that are gone can be marked removed.
      if (!Array.isArray(b.ids) || b.ids.length > 20000 || !b.ids.every((i) => typeof i === "string")) return c.json({ error: "ids must be a list of song ids" }, 400);
      return c.json(await finishSync(c.env, fam, b.ids as string[]));
    }
    return c.json(await syncPage(c.env, fam, Math.max(0, Number(b.offset) || 0)));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "NAS sync failed" }, 502);
  }
});

/** Starts a Navidrome library scan (owner only). */
app.post("/api/nas/scan", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  if (!nasEnabled(c.env)) return c.json({ error: "NAS is not configured" }, 501);
  try {
    await startScan(c.env);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Could not start the scan" }, 502);
  }
});

app.get("/api/nas/scan", async (c) => {
  if (!nasEnabled(c.env)) return c.json({ error: "NAS is not configured" }, 501);
  try {
    return c.json({ scanning: await scanning(c.env) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Could not read the scan status" }, 502);
  }
});

// ---- Beets on the home server -------------------------------------------------------------

app.get("/api/beets/runs", async (c) => c.json({ runs: await listRuns(c.env.DB, c.get("family").familyId) }));

/** Whether the home server API answers. The app disables editing, Organize and enrich while it does not. */
app.get("/api/server/status", async (c) => c.json(await homeStatus(c.env)));

/** Starts an import or an enrich on the home server (owner only). Fails at once, with the reason, if it is unreachable. */
async function startOnHome(c: import("hono").Context<{ Bindings: Env; Variables: Vars }>, kind: "import" | "enrich") {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  if (!homeConfigured(c.env)) return c.json({ error: "The home server API is not configured." }, 501);
  const fam = c.get("family").familyId;
  const uid = c.get("user").uid;
  let { run, created } = await beginRun(c.env.DB, fam, uid, kind);
  if (!created) {
    // A run is marked running, but if the server says it is not doing that job (it was restarted, or its report was lost)
    // the record is stale: close it and start again instead of making the owner wait for the 2 hour timeout.
    const st = await homeStatus(c.env);
    if (st.ok && goneFromServer(run, st.jobs ?? (st.busy === kind ? [{ id: run.id }] : []))) {
      await failRun(c.env.DB, run.id, "The server is no longer running this job (it restarted or its report was lost).");
      ({ run, created } = await beginRun(c.env.DB, fam, uid, kind));
    }
  }
  if (created) {
    try {
      await homeStartJob(c.env, run.id, kind);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not start the job";
      await failRun(c.env.DB, run.id, msg);
      return c.json({ error: msg }, 502);
    }
  }
  return c.json(run, 201);
}

/** Starts a Beets import now (the Organize button). */
app.post("/api/beets/run", (c) => startOnHome(c, "import"));

/** Starts an enrich now (cover art and genres), e.g. when the nightly one did not happen. */
app.post("/api/beets/enrich", (c) => startOnHome(c, "enrich"));

const youtubeOwner = (c: import("hono").Context<{ Bindings: Env; Variables: Vars }>) =>
  c.get("family").role !== "owner" ? c.json({ error: "owner only" }, 403) : !homeConfigured(c.env) ? c.json({ error: "The home server API is not configured." }, 501) : null;

/** Reads a YouTube link's title and artist (owner only), so the owner can confirm or edit them before downloading. */
app.post("/api/beets/youtube/info", async (c) => {
  const denied = youtubeOwner(c);
  if (denied) return denied;
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
  if (typeof url !== "string" || !url.trim() || url.length > 300) return c.json({ error: "Paste a YouTube link." }, 400);
  try {
    return c.json(await homeYoutubeInfo(c.env, url.trim()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Could not read that link" }, 502);
  }
});

/**
 * Adds one YouTube video to the queue (owner only). Any number of links can be added at any time; the home server
 * downloads a few at once and the rest wait here (status 'requested') until a slot frees up.
 */
app.post("/api/beets/youtube", async (c) => {
  const denied = youtubeOwner(c);
  if (denied) return denied;
  const b = await c.req.json<{ url?: string; title?: string; artist?: string; album?: string; ai?: boolean }>().catch(() => ({}) as Record<string, undefined>);
  const url = typeof b.url === "string" ? b.url.trim() : "";
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 200) : "";
  const artist = typeof b.artist === "string" ? b.artist.trim().slice(0, 200) : "";
  const album = typeof b.album === "string" ? b.album.trim().slice(0, 200) : "";
  if (!url || url.length > 300 || !title || !artist) return c.json({ error: "A link, a title and an artist are required." }, 400);
  const st = await homeStatus(c.env);
  if (!st.ok) return c.json({ error: st.error || "Cannot reach the home server." }, 502);
  const fam = c.get("family").familyId;
  const { run, created } = await enqueueYoutube(c.env.DB, fam, c.get("user").uid, { url, title, artist, album });
  if (!created) return c.json(run, 200); // the same link is already queued or downloading
  // The song reaches the library with the next NAS sync; the badge is applied then (worker/nas.ts).
  if (b.ai === true) {
    await c.env.DB.prepare("INSERT INTO pending_ai (family_id, title, artist, created_at) VALUES (?, ?, ?, ?)")
      .bind(fam, title.normalize("NFC"), artist.normalize("NFC"), Date.now()).run();
  }
  await dispatchQueued(c.env);
  const now = (await getRun(c.env.DB, run.id)) ?? run;
  if (now.status === "failed") return c.json({ error: now.log || "Could not start the job" }, 502);
  return c.json(now, 201);
});

/**
 * The home server's nightly job: builds the AI mixes for a slice of members (?offset=&limit=, limit at most 5) and
 * answers {members, mixes}; it repeats with the next offset until fewer members than the limit come back.
 */
app.post("/api/beets/agent/mixes", async (c) => {
  if (!agentKeyOk(c.env, c.req.header("X-Agent-Key"))) return c.json({ error: "unauthorized" }, 401);
  const q = c.req.query();
  return c.json(await buildMixSlice(c.env, Number(q.offset ?? 0), Number(q.limit ?? 2)));
});

/** The nightly enrich script announces a run: its id as text. It reports the result through /report like an import. */
app.post("/api/beets/agent/enrich-start", async (c) => {
  if (!agentKeyOk(c.env, c.req.header("X-Agent-Key"))) return c.json({ error: "unauthorized" }, 401);
  const id = await startAgentRun(c.env.DB, "enrich");
  return id ? c.text(id) : c.json({ error: "no family" }, 404);
});

/** The home server's inbox watcher announces an import of files that arrived by themselves: its id as text. */
app.post("/api/beets/agent/import-start", async (c) => {
  if (!agentKeyOk(c.env, c.req.header("X-Agent-Key"))) return c.json({ error: "unauthorized" }, 401);
  const id = await startAgentRun(c.env.DB, "import");
  return id ? c.text(id) : c.json({ error: "no family" }, 404);
});

/** The home server started: runs it had going died with it. Closes them and goes on with the queued YouTube links. */
app.post("/api/beets/agent/reset", async (c) => {
  if (!agentKeyOk(c.env, c.req.header("X-Agent-Key"))) return c.json({ error: "unauthorized" }, 401);
  await resetRunning(c.env.DB);
  c.executionCtx.waitUntil(dispatchQueued(c.env));
  return c.json({ ok: true });
});

/** Progress heartbeat while a run is going: ?id=&before=&now= (files in the inbox). */
app.post("/api/beets/agent/progress", async (c) => {
  if (!agentKeyOk(c.env, c.req.header("X-Agent-Key"))) return c.json({ error: "unauthorized" }, 401);
  const q = c.req.query();
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  if (!q.id) return c.json({ error: "id required" }, 400);
  return (await updateProgress(c.env.DB, q.id, num(q.before), num(q.now))) ? c.json({ ok: true }) : c.json({ error: "no such running run" }, 404);
});

/** The script's result for a run: ?id=&ok=1|0&before=&after=&exit= with the log tail as the plain-text body. */
app.post("/api/beets/agent/report", async (c) => {
  if (!agentKeyOk(c.env, c.req.header("X-Agent-Key"))) return c.json({ error: "unauthorized" }, 401);
  const q = c.req.query();
  const num = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null);
  if (!q.id) return c.json({ error: "id required" }, 400);
  const ok = await finishRun(c.env.DB, {
    id: q.id, ok: q.ok === "1", inboxBefore: num(q.before), inboxAfter: num(q.after), exitCode: num(q.exit), log: await c.req.text(),
  });
  c.executionCtx.waitUntil(dispatchQueued(c.env)); // a download slot may have freed up
  return ok ? c.json({ ok: true }) : c.json({ error: "no such running run" }, 404);
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
  if (row.art_key.startsWith("nas:")) return nasEnabled(c.env) ? proxyCover(c.env, row.art_key.slice(4)) : c.json({ error: "not found" }, 404);
  if (c.req.query("w") === "car") {
    const small = await carArt(c.env, c.get("family").familyId, c.req.param("id"), row.art_key);
    if (small) return small;
  }
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
