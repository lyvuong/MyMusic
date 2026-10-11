import { findSongArt } from "./artwork";
import { claimRun, failRun, nextQueuedYoutube, requeueRun, runningYoutubeCount } from "./beets";
import { HomeError, homeStartJob } from "./home";

/** How many YouTube downloads the Worker lets run on the home server at once (the server enforces the same cap). */
export const MAX_YOUTUBE = 3;

/** A real cover when iTunes knows this song (artist and title must match); otherwise the server crops the video's thumbnail. */
async function coverFor(artist: string, title: string): Promise<Record<string, string>> {
  const art = await findSongArt(artist, title).catch(() => null);
  if (!art) return {};
  const bytes = new Uint8Array(art.data);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { cover: btoa(bin) };
}

/**
 * Starts queued YouTube links while fewer than MAX_YOUTUBE are running. The queue is the beets_runs table, so it
 * survives restarts of both sides. Call it after adding a link and after every report from the server.
 *
 * A link the server cannot take right now (409, or unreachable) goes back to the queue; one it refuses for good fails
 * with the reason, and the next link is tried.
 */
export async function dispatchQueued(env: Env): Promise<void> {
  for (let i = 0; i < MAX_YOUTUBE * 4; i++) {
    if ((await runningYoutubeCount(env.DB)) >= MAX_YOUTUBE) return;
    const next = await nextQueuedYoutube(env.DB);
    if (!next) return;
    if (!(await claimRun(env.DB, next.run.id))) continue; // another request took it
    const { url, title, artist, album } = next.payload;
    try {
      await homeStartJob(env, next.run.id, "youtube", { url, title, artist, album, ...(await coverFor(artist, title)) });
    } catch (e) {
      const busy = e instanceof HomeError && e.status === 409;
      const unreachable = e instanceof HomeError && e.status === undefined;
      if (busy || unreachable) {
        await requeueRun(env.DB, next.run.id);
        return;
      }
      await failRun(env.DB, next.run.id, e instanceof Error ? e.message : "Could not start the job");
    }
  }
}
