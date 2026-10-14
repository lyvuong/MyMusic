import type { Track } from "../shared/types";
import { api } from "./api";

/**
 * Google Cast (Chrome and Edge) with the Default Media Receiver: the cast device fetches the songs itself from signed
 * URLs (see worker/cast.ts), this page only sends the queue and the play/pause/seek commands and mirrors the state.
 * The Cast SDK has no TypeScript types here, so it is used through `any`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface CastSnapshot {
  /** The SDK loaded and a cast device is around (or a session is running). */
  available: boolean;
  casting: boolean;
  device: string;
  playing: boolean;
  position: number;
  duration: number;
  /** The id of the song the device is playing now. */
  trackId: string | null;
  error: string;
}

let snap: CastSnapshot = { available: false, casting: false, device: "", playing: false, position: 0, duration: 0, trackId: null, error: "" };
const listeners = new Set<() => void>();
const publish = (patch: Partial<CastSnapshot>) => {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
};
export const getCast = () => snap;
export const subscribeCast = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

let ctx: Any = null;
let player: Any = null;
let controller: Any = null;
let started = false;
let loadId = 0;

function sync() {
  if (!ctx) return;
  const session = ctx.getCurrentSession();
  const casting = !!session;
  const state = player.playerState as string | undefined;
  publish({
    available: casting || ctx.getCastState() !== "NO_DEVICES_AVAILABLE",
    casting,
    device: casting ? (session.getCastDevice?.().friendlyName ?? "") : "",
    playing: casting && (state === "PLAYING" || state === "BUFFERING"),
    position: casting ? (player.currentTime ?? 0) : 0,
    duration: casting ? (player.duration ?? 0) : 0,
    trackId: casting ? ((player.mediaInfo?.customData?.id as string | undefined) ?? null) : null,
  });
}

function setup() {
  const w = window as Any;
  const cast = w.cast;
  const chrome = w.chrome;
  ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  player = new cast.framework.RemotePlayer();
  controller = new cast.framework.RemotePlayerController(player);
  ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, sync);
  ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, sync);
  controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, sync);
  sync();
}

/** Loads the Cast SDK once. Browsers without Cast support simply never become `available`. */
export function initCast() {
  if (started) return;
  started = true;
  (window as Any).__onGCastApiAvailable = (ok: boolean) => {
    if (ok) setup();
  };
  const s = document.createElement("script");
  s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
  s.async = true;
  document.head.append(s);
}

/** Opens the browser's device picker. */
export async function startCastSession() {
  if (!ctx) return;
  try {
    await ctx.requestSession();
  } catch {
    /* dismissed */
  }
}

export function stopCastSession() {
  ctx?.endCurrentSession(true);
}

export const castPlayPause = () => controller?.playOrPause();
export function castSeek(seconds: number) {
  if (!player) return;
  player.currentTime = seconds;
  controller.seek();
}

/** Volume of the device while casting (0 to 1). */
export function castSetVolume(level: number) {
  if (!player) return;
  player.volumeLevel = level;
  controller.setVolumeLevel();
}

const CHUNK = 20; // a Cast message is limited to 64 KB, so long queues go over in pieces

/**
 * Replaces the device's queue with `tracks[index..]` (everything after the song to start, so a whole playlist plays on)
 * and starts it at `startAt` seconds. Goes back to the earlier songs by loading again from there.
 */
export async function castLoadQueue(tracks: Track[], index: number, startAt: number) {
  const session = ctx?.getCurrentSession();
  if (!session || !tracks[index]) return;
  const mine = ++loadId;
  const chrome = (window as Any).chrome;
  const list = tracks.slice(index, index + 500);
  try {
    const { items: urls } = await api.castMedia(list.map((t) => t.id));
    const queueItem = (t: Track) => {
      const u = urls[t.id];
      if (!u) return null;
      const info = new chrome.cast.media.MediaInfo(u.stream, t.mime || "audio/mpeg");
      info.streamType = chrome.cast.media.StreamType.BUFFERED;
      if (t.duration > 0) info.duration = t.duration;
      const md = new chrome.cast.media.MusicTrackMediaMetadata();
      md.title = t.title;
      md.artist = t.artist;
      md.albumName = t.album;
      if (u.art) md.images = [new chrome.cast.Image(u.art)];
      info.metadata = md;
      info.customData = { id: t.id };
      const qi = new chrome.cast.media.QueueItem(info);
      qi.autoplay = true;
      qi.preloadTime = 20;
      return qi;
    };
    const all = list.map(queueItem).filter(Boolean);
    if (all.length === 0) throw new Error("None of these songs can be cast.");
    const req = new chrome.cast.media.QueueLoadRequest(all.slice(0, CHUNK));
    req.startIndex = 0;
    req.currentTime = startAt;
    req.repeatMode = chrome.cast.media.RepeatMode.OFF;
    const media: Any = await new Promise((res, rej) => session.getSessionObj().queueLoad(req, res, (e: Any) => rej(new Error(e?.description || e?.code || "The device refused the queue."))));
    publish({ error: "" });
    for (let i = CHUNK; i < all.length; i += CHUNK) {
      if (mine !== loadId || ctx.getCurrentSession() !== session) return; // a newer load or the session ended
      const more = new chrome.cast.media.QueueInsertItemsRequest(all.slice(i, i + CHUNK));
      await new Promise((res, rej) => media.queueInsertItems(more, res, (e: Any) => rej(new Error(e?.description || "Could not add more songs."))));
    }
  } catch (e) {
    publish({ error: e instanceof Error ? e.message : String(e) });
  }
}
