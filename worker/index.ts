import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { signedQuery, verifySigned } from "./cast";
import { verifyIdToken, type User } from "./auth";
import { createFamily, createInvite, familyInfo, joinWithInvite, membershipOf, removeMember, type Membership } from "./family";
import { setArtistGenre } from "./genres";
import { findAlbumArt, findArtistImage } from "./artwork";
import { cleanName, delta, editTitles, editTrack, renameGroup, savePlaylist } from "./library";
import { agentKeyOk, beginRun, enqueueYoutube, failRun, finishRun, getRun, goneFromServer, listRuns, resetRunning, startAgentRun, updateProgress } from "./beets";
import { dispatchQueued } from "./ytqueue";
import { findDuplicates, resolveDuplicates } from "./duplicates";
import { addToPlaylist, findInLibrary, queueForPlaylist } from "./ytplaylist";
import { HomeError, homeConfigured, homeCover, homeEdit, homeStartJob, homeStatus, homeYoutubeInfo, homeYoutubePlaylist, type TagOp } from "./home";
import { finishSync, nasEnabled, proxyCover, proxyStream, scanning, startScan, syncPage } from "./nas";
import { getRatings, setRating } from "./ratings";
import { recordPlays, recordSkips, popular } from "./plays";
import { familyTaste } from "./taste";
import { browse, clearLibraryCache, groupTracks, homeData, nameSuggestions, touchMember, tracksByIds, PAGE_GROUPED, PAGE_SONGS } from "./browse";
import { buildMixesFor, buildMixSlice, getMixes } from "./mixes";
import { carArt } from "./carart";
import { suggest, SuggestError } from "./suggest";
import { ingest } from "./upload";
import { HAS_ARTIST, NO_ALBUM, autoApplyOn, nightlyAlbums, savedSuggestions, suggestFor, type SongRow } from "./albumjob";
import { loadCorrections, restoreAccents, saveCorrections, VietnameseError, type AccentItem } from "./vietnamese";

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
for (const p of ["/api/library", "/api/playlists/*", "/api/upload", "/api/library/*", "/api/tracks/*", "/api/stream/*", "/api/art/*", "/api/artist-art/*", "/api/nas/*", "/api/beets/run", "/api/beets/enrich", "/api/beets/runs", "/api/beets/youtube", "/api/beets/youtube/*", "/api/server/status", "/api/family/invites", "/api/family/taste", "/api/ratings", "/api/ratings/*", "/api/suggest", "/api/plays", "/api/popular", "/api/mixes", "/api/mixes/*", "/api/art-urls", "/api/cast/*", "/api/vietnamese/*", "/api/albums/*", "/api/home", "/api/browse", "/api/group", "/api/names"]) {
  app.use(p, needFamily);
}

// ---- Family -------------------------------------------------------------------------------

app.get("/api/family", async (c) => {
  const m = await membershipOf(c.env.DB, c.get("user").uid);
  return m ? c.json(await familyInfo(c.env.DB, m)) : c.json({ error: "no family" }, 404);
});

/** Every member's taste profile (top three artists and songs), rebuilt with the nightly mixes. */
app.get("/api/family/taste", async (c) => c.json({ profiles: await familyTaste(c.env.DB, c.get("family").familyId) }));

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
  await touchMember(c.env.DB, c.get("user").uid);
  // ?tracks=0: playlists and the clock only. The web page finds songs through /api/browse instead of loading them all.
  return c.json(await delta(c.env.DB, c.get("family").familyId, c.get("user").uid, since, c.req.query("tracks") !== "0"));
});

/** The start page: the caller's mixes, the newest songs, most played, loved and genres, without the library. */
app.get("/api/home", async (c) => c.json(await homeData(c.env.DB, c.get("family").familyId, c.get("user").uid)));

/** A page of songs: `q` searches (accents and word order ignored), `genre` narrows, no `q` lists the newest first. */
app.get("/api/browse", async (c) => {
  const q = c.req.query();
  const grouped = q.view === "albums" || q.view === "artists";
  return c.json(await browse(c.env.DB, c.get("family").familyId, {
    q: (q.q ?? "").slice(0, 100), genre: q.genre, cursor: Number(q.cursor ?? 0) || 0, limit: grouped ? PAGE_GROUPED : PAGE_SONGS,
  }));
});

/** Every song of one album or artist (`?kind=album|artist&name=`), for its page. */
app.get("/api/group", async (c) => {
  const kind = c.req.query("kind");
  const name = c.req.query("name") ?? "";
  if ((kind !== "album" && kind !== "artist") || !name) return c.json({ error: "bad request" }, 400);
  return c.json({ tracks: await groupTracks(c.env.DB, c.get("family").familyId, kind, name) });
});

/** Existing artist or album names that match what is typed (`?kind=&q=`), for the edit dialogs. */
app.get("/api/names", async (c) => {
  const kind = c.req.query("kind");
  if (kind !== "album" && kind !== "artist") return c.json({ error: "bad request" }, 400);
  return c.json({ names: await nameSuggestions(c.env.DB, c.get("family").familyId, kind, (c.req.query("q") ?? "").slice(0, 100)) });
});

/** Songs by id (up to 100), for playlists and mixes that only hold ids. */
app.post("/api/tracks/by-ids", async (c) => {
  const b = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = Array.isArray(b?.ids) ? (b!.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 100) : [];
  return c.json({ tracks: await tracksByIds(c.env.DB, c.get("family").familyId, ids) });
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

/**
 * Plays and skips to record: `{ plays?: [{ trackId, at }], skips?: [...] }`, `at` in epoch ms; the app sends them in
 * batches. A play is a song listened to for a minute or to its end; a skip is one the member moved on from sooner.
 */
app.post("/api/plays", async (c) => {
  const b = await c.req.json<{ plays?: { trackId: string; at: number }[]; skips?: { trackId: string; at: number }[] }>().catch(() => null);
  const plays = Array.isArray(b?.plays) ? b!.plays : null;
  const skips = Array.isArray(b?.skips) ? b!.skips : null;
  if (!plays && !skips) return c.json({ error: "bad request" }, 400);
  const { familyId } = c.get("family");
  const { uid } = c.get("user");
  return c.json({
    saved: plays ? await recordPlays(c.env.DB, familyId, uid, plays) : 0,
    skipped: skips ? await recordSkips(c.env.DB, familyId, uid, skips) : 0,
  });
});

/** The family's most played songs lately, most played first. */
app.get("/api/popular", async (c) => c.json({ tracks: await popular(c.env.DB, c.get("family").familyId) }));

/** The caller's AI mixes (one per time of day), built overnight. Empty until the first night run. */
app.get("/api/mixes", async (c) => {
  await touchMember(c.env.DB, c.get("user").uid);
  return c.json({ mixes: await getMixes(c.env.DB, c.get("user").uid) });
});

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

/** Sets the genre of an artist's songs that have none in their tags; an empty genre lets the app guess again. */
app.put("/api/artist-genre", async (c) => {
  const b = await c.req.json<{ artist?: unknown; genre?: unknown }>().catch(() => null);
  const artist = cleanName(b?.artist);
  if (!b || !artist) return c.json({ error: "bad request" }, 400);
  await setArtistGenre(c.env.DB, c.get("family").familyId, artist, cleanName(b.genre, 40));
  return c.json({ ok: true });
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
 * Changes the titles of up to 90 songs at once (owner only), used by the Vietnamese clean-up. The files are written
 * first; if that fails nothing changes. Artist and album names go through /api/library/rename.
 */
app.post("/api/library/titles", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const b = await c.req.json<{ edits?: unknown }>().catch(() => null);
  const raw = Array.isArray(b?.edits) ? (b.edits as { id?: unknown; title?: unknown }[]) : null;
  if (!raw || raw.length === 0 || raw.length > 90) return c.json({ error: "send 1 to 90 edits" }, 400);
  const edits: { id: string; title: string }[] = [];
  for (const e of raw) {
    const title = cleanName(e?.title);
    if (typeof e?.id !== "string" || !e.id || !title) return c.json({ error: "every edit needs an id and a title" }, 400);
    edits.push({ id: e.id, title });
  }
  let files: Awaited<ReturnType<typeof homeEdit>> | null = null;
  try {
    const r = await editTitles(c.env.DB, c.get("family").familyId, edits, async (plans) => {
      const ops = plans.filter((p) => p.source === "nas").map((p) => ({ kind: "song", match: p.before, set: p.applied }) satisfies TagOp);
      if (ops.length) files = await homeEdit(c.env, ops);
    });
    return c.json({ ...r, ...(await afterFileEdit(c.env, c.executionCtx, files)) });
  } catch (e) {
    if (e instanceof HomeError) return c.json({ error: e.message }, 502);
    throw e;
  }
});

/** Asks the AI to add Vietnamese accents to up to 25 names written without them (owner only). */
app.post("/api/vietnamese/restore", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const b = await c.req.json<{ items?: unknown }>().catch(() => null);
  const raw = Array.isArray(b?.items) ? (b.items as Record<string, unknown>[]) : null;
  if (!raw || raw.length === 0 || raw.length > 25) return c.json({ error: "send 1 to 25 names" }, 400);
  const items: AccentItem[] = [];
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => x.slice(0, 200)) : undefined);
  for (const it of raw) {
    const text = typeof it?.text === "string" ? it.text.trim() : "";
    if (typeof it?.key !== "string" || it.key.length > 80 || !text || text.length > 200) return c.json({ error: "bad name" }, 400);
    items.push({ key: it.key, text, kind: it.kind === "title" || it.kind === "album" || it.kind === "artist" ? it.kind : undefined, artist: typeof it.artist === "string" ? it.artist.slice(0, 200) : undefined, album: typeof it.album === "string" ? it.album.slice(0, 200) : undefined,
      hints: strings(it.hints, 12), samples: strings(it.samples, 3) });
  }
  try {
    const learned = await loadCorrections(c.env.DB, c.get("family").familyId);
    return c.json({ results: await restoreAccents(c.env, items, learned) });
  } catch (e) {
    if (e instanceof VietnameseError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

/**
 * Album suggestions for up to 5 songs that have none (owner only), from online catalogues and, for songs whose files are
 * on the home server, from their sound (AcoustID). What is found is saved as open suggestions (or "none").
 */
app.post("/api/albums/suggest", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const b = await c.req.json<{ items?: unknown }>().catch(() => null);
  const raw = Array.isArray(b?.items) ? (b.items as Record<string, unknown>[]) : null;
  if (!raw || raw.length === 0 || raw.length > 5) return c.json({ error: "send 1 to 5 songs" }, 400);
  const ids = raw.map((it) => (typeof it?.id === "string" ? it.id : "")).filter(Boolean);
  const rows = ids.length
    ? await c.env.DB.prepare(`SELECT id, source, title, artist, album, track_no, duration FROM tracks WHERE family_id = ? AND deleted = 0 AND id IN (${ids.map(() => "?").join(",")})`)
        .bind(c.get("family").familyId, ...ids).all<SongRow>()
    : { results: [] as SongRow[] };
  const { guesses, soundNote } = await suggestFor(c.env, rows.results.filter((r) => r.artist && r.title));
  // Keep what was found, like the nightly run does, so the list is still there after a reload.
  const now = Date.now();
  const fam = c.get("family").familyId;
  const looked = rows.results.filter((r) => r.artist && r.title);
  if (looked.length) {
    await c.env.DB.batch(looked.map((r) => {
      const g = guesses.get(r.id) ?? [];
      return c.env.DB.prepare("INSERT OR REPLACE INTO album_suggestions (family_id, track_id, guesses, status, checked_at) VALUES (?, ?, ?, ?, ?)")
        .bind(fam, r.id, JSON.stringify(g), g.length ? "open" : "none", now);
    }));
  }
  return c.json({ results: ids.map((id) => ({ id, guesses: guesses.get(id) ?? [] })), soundNote });
});

/** Every song that has an artist and title but no album (owner only): the list the "find now" button looks up. */
app.get("/api/albums/missing", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const r = await c.env.DB.prepare(`SELECT id, title, artist, duration FROM tracks t WHERE t.family_id = ? AND t.deleted = 0 AND ${NO_ALBUM} AND ${HAS_ARTIST} AND t.title <> '' ORDER BY artist, title LIMIT 5000`)
    .bind(c.get("family").familyId).all<{ id: string; title: string; artist: string; duration: number }>();
  return c.json({ items: r.results });
});

/** What the nightly run saved for the owner to confirm, how many songs it found nothing for, and the auto-apply switch. */
app.get("/api/albums/saved", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const fam = c.get("family").familyId;
  const counts = await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM album_suggestions WHERE family_id = ? GROUP BY status")
    .bind(fam).all<{ status: string; n: number }>();
  const n = (s: string) => counts.results.find((r) => r.status === s)?.n ?? 0;
  return c.json({ items: await savedSuggestions(c.env.DB, fam), none: n("none"), dismissed: n("dismissed"), autoApply: await autoApplyOn(c.env.DB, fam) });
});

/**
 * The owner dealt with songs: "applied" forgets their suggestions (they have an album now), "dismissed" keeps them out of
 * the nightly run, "retry" forgets the songs nothing was found for (and the dismissed ones) so they are looked up again.
 */
app.post("/api/albums/resolve", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const b = await c.req.json<{ status?: unknown; ids?: unknown }>().catch(() => null);
  const fam = c.get("family").familyId;
  if (b?.status === "retry") {
    await c.env.DB.prepare("DELETE FROM album_suggestions WHERE family_id = ? AND status IN ('none', 'dismissed')").bind(fam).run();
    return c.json({ ok: true });
  }
  const ids = Array.isArray(b?.ids) ? (b.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  if ((b?.status !== "applied" && b?.status !== "dismissed") || ids.length === 0) return c.json({ error: "bad request" }, 400);
  const marks = ids.map(() => "?").join(",");
  await c.env.DB.prepare(b.status === "applied"
    ? `DELETE FROM album_suggestions WHERE family_id = ? AND track_id IN (${marks})`
    : `UPDATE album_suggestions SET status = 'dismissed' WHERE family_id = ? AND track_id IN (${marks})`).bind(fam, ...ids).run();
  return c.json({ ok: true });
});

/** Turns the nightly auto-apply on or off for the family. */
app.post("/api/albums/settings", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const b = await c.req.json<{ autoApply?: unknown }>().catch(() => null);
  if (typeof b?.autoApply !== "boolean") return c.json({ error: "bad request" }, 400);
  await c.env.DB.prepare("INSERT INTO album_settings (family_id, auto_apply) VALUES (?, ?) ON CONFLICT(family_id) DO UPDATE SET auto_apply = excluded.auto_apply")
    .bind(c.get("family").familyId, b.autoApply ? 1 : 0).run();
  return c.json({ autoApply: b.autoApply });
});

/**
 * The home server's nightly job: looks up a few songs without an album (?limit=, at most 5) and saves the suggestions.
 * Answers {checked, saved, applied, remaining}; it repeats until nothing is left or its nightly cap is reached.
 */
app.post("/api/beets/agent/albums", async (c) => {
  if (!agentKeyOk(c.env, c.req.header("X-Agent-Key"))) return c.json({ error: "unauthorized" }, 401);
  const r = await nightlyAlbums(c.env, Number(c.req.query().limit ?? 5));
  if (r.filesWritten > 0) await afterFileEdit(c.env, c.executionCtx, { written: r.filesWritten, skipped: [] });
  return c.json(r);
});

/** The family's saved corrections (what the owner changed the AI's suggestions to), so the page can skip or hide names. */
app.get("/api/vietnamese/corrections", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  return c.json({ corrections: await loadCorrections(c.env.DB, c.get("family").familyId) });
});

/** Remembers corrections for the whole family; from = to means "leave this name alone". */
app.post("/api/vietnamese/corrections", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  const b = await c.req.json<{ items?: unknown }>().catch(() => null);
  const raw = Array.isArray(b?.items) ? (b.items as Record<string, unknown>[]) : null;
  if (!raw || raw.length === 0 || raw.length > 200) return c.json({ error: "send 1 to 200 corrections" }, 400);
  const pairs: { from: string; to: string }[] = [];
  for (const it of raw) {
    const from = typeof it?.from === "string" ? it.from.trim() : "";
    const to = typeof it?.to === "string" ? it.to.trim() : "";
    if (!from || !to || from.length > 200 || to.length > 200) return c.json({ error: "bad correction" }, 400);
    pairs.push({ from, to });
  }
  return c.json({ saved: await saveCorrections(c.env.DB, c.get("family").familyId, c.get("user").uid, pairs) });
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
  await clearLibraryCache(c.env.DB, fam);
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

const songNames = (v: unknown) =>
  Array.isArray(v) && v.length <= 100 && v.every((s) => typeof s?.title === "string" && typeof s?.artist === "string")
    ? (v as { title: string; artist: string }[]).map((s) => ({ title: s.title.trim().slice(0, 200), artist: s.artist.trim().slice(0, 200) }))
    : null;

/** Which of these songs are in the library already (owner only): the library id of each, or null. */
app.post("/api/beets/youtube/check", async (c) => {
  const denied = youtubeOwner(c);
  if (denied) return denied;
  const b = await c.req.json<{ songs?: unknown }>().catch(() => ({}) as { songs?: unknown });
  const songs = songNames(b.songs);
  if (!songs) return c.json({ error: "songs must be a list of up to 100 titles with artists." }, 400);
  return c.json({ found: await findInLibrary(c.env.DB, c.get("family").familyId, songs) });
});

/** Puts songs that are in the library already into the member's playlist of that name, without downloading anything. */
app.post("/api/beets/youtube/playlist-add", async (c) => {
  const denied = youtubeOwner(c);
  if (denied) return denied;
  const b = await c.req.json<{ playlist?: string; songs?: unknown }>().catch(() => ({}) as { playlist?: string; songs?: unknown });
  const songs = songNames(b.songs);
  const name = typeof b.playlist === "string" ? b.playlist.trim().slice(0, 100) : "";
  if (!songs || !name) return c.json({ error: "A playlist name and a list of songs are required." }, 400);
  const { familyId } = c.get("family");
  const ids = (await findInLibrary(c.env.DB, familyId, songs)).filter((x): x is string => x !== null);
  return c.json({ added: await addToPlaylist(c.env.DB, familyId, c.get("user").uid, name, ids) });
});

/** Songs the library holds more than once, grouped, with the copy to keep suggested (owner only). */
app.get("/api/library/duplicates", async (c) => {
  if (c.get("family").role !== "owner") return c.json({ error: "owner only" }, 403);
  return c.json({ groups: await findDuplicates(c.env.DB, c.get("family").familyId) });
});

/** Deletes the chosen duplicate copies for good and moves their playlist places and ratings to the kept song (owner only). */
app.post("/api/library/duplicates/resolve", async (c) => {
  const denied = youtubeOwner(c);
  if (denied) return denied;
  const b = await c.req.json<{ groups?: { keep?: string; remove?: string[] }[] }>().catch(() => ({}) as { groups?: undefined });
  const groups = b.groups;
  const ok = Array.isArray(groups) && groups.length >= 1 && groups.length <= 50 &&
    groups.every((g) => typeof g.keep === "string" && Array.isArray(g.remove) && g.remove.length >= 1 && g.remove.length <= 20 && g.remove.every((x) => typeof x === "string"));
  if (!ok) return c.json({ error: "groups must be 1-50 groups with the song to keep and 1-20 copies to remove." }, 400);
  return c.json(await resolveDuplicates(c.env, c.get("family").familyId, groups as { keep: string; remove: string[] }[]));
});

/** Lists the videos of a YouTube / YouTube Music playlist (owner only); the app then looks each one up as usual. */
app.post("/api/beets/youtube/playlist", async (c) => {
  const denied = youtubeOwner(c);
  if (denied) return denied;
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
  if (typeof url !== "string" || !url.trim() || url.length > 300) return c.json({ error: "Paste a playlist link." }, 400);
  try {
    return c.json(await homeYoutubePlaylist(c.env, url.trim()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Could not read that playlist" }, 502);
  }
});

/**
 * Adds one YouTube video to the queue (owner only). Any number of links can be added at any time; the home server
 * downloads a few at once and the rest wait here (status 'requested') until a slot frees up.
 */
app.post("/api/beets/youtube", async (c) => {
  const denied = youtubeOwner(c);
  if (denied) return denied;
  const b = await c.req.json<{ url?: string; title?: string; artist?: string; album?: string; ai?: boolean; playlist?: string }>().catch(() => ({}) as Record<string, undefined>);
  const url = typeof b.url === "string" ? b.url.trim() : "";
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 200) : "";
  const artist = typeof b.artist === "string" ? b.artist.trim().slice(0, 200) : "";
  // Songs from YouTube without an album of their own are collected in one called "YouTube".
  const album = (typeof b.album === "string" ? b.album.trim().slice(0, 200) : "") || "YouTube";
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
  // A song from a YouTube playlist joins a MyMusic playlist of the same name once the sync has put it in the library.
  const playlist = typeof b.playlist === "string" ? b.playlist.trim().slice(0, 100) : "";
  if (playlist) await queueForPlaylist(c.env.DB, fam, c.get("user").uid, playlist, title, artist);
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
