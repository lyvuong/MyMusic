import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Track } from "../shared/types";
import { api } from "./api";
import { AiBadge, ArtistPic, Cover } from "./art";
import { castLoadQueue, castPlayPause, castSeek, getCast, initCast, startCastSession, stopCastSession, subscribeCast } from "./cast";
import { Stars } from "./ratings";

interface PlayerValue {
  current: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  play: (queue: Track[], index: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  /** Stops playback and hides the player bar. */
  close: () => void;
  /** Google Cast: `available` once a device is around; `casting` while the songs play on that device. */
  cast: { available: boolean; casting: boolean; device: string; error: string };
  startCast: () => void;
  stopCast: () => void;
}

const Ctx = createContext<PlayerValue | null>(null);
export const usePlayer = () => useContext(Ctx)!;

/** One <audio> element for the whole page; media URLs carry a fresh token and are re-fetched if it expires. */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const resume = useRef(0); // where to continue after a token refresh
  const current = index >= 0 ? (queue[index] ?? null) : null;

  // Google Cast: while a session runs the songs play on the device and this page only sends commands.
  const cast = useSyncExternalStore(subscribeCast, getCast);
  const castRef = useRef(cast);
  castRef.current = cast;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const indexRef = useRef(index);
  indexRef.current = index;
  const fromDevice = useRef<string | null>(null); // a song change that the device made by itself
  const lastCastPos = useRef(0);
  useEffect(initCast, []);

  const load = useCallback(async (t: Track, startAt = 0, autoplay = true) => {
    const el = audio.current!;
    resume.current = startAt;
    el.src = await api.mediaUrl("stream", t.id);
    if (!autoplay) return;
    try {
      await el.play();
    } catch {
      /* autoplay blocked or superseded */
    }
  }, []);

  useEffect(() => {
    if (!current) return;
    if (!castRef.current.casting) {
      void load(current);
    } else if (fromDevice.current === current.id) {
      fromDevice.current = null; // the device already moved on to this song
    } else {
      void castLoadQueue(queueRef.current, indexRef.current, 0);
    }
  }, [current, load]);

  // A session starts: hand the queue over to the device. It ends: come back to the same song here, paused.
  const wasCasting = useRef(false);
  useEffect(() => {
    if (cast.casting && !wasCasting.current) {
      const el = audio.current!;
      const pos = el.currentTime || 0;
      el.pause();
      if (queueRef.current[indexRef.current]) void castLoadQueue(queueRef.current, indexRef.current, pos);
    } else if (!cast.casting && wasCasting.current) {
      const t = queueRef.current[indexRef.current];
      if (t) void load(t, lastCastPos.current, false);
    }
    wasCasting.current = cast.casting;
  }, [cast.casting, load]);
  useEffect(() => {
    if (cast.casting) lastCastPos.current = cast.position;
  }, [cast.casting, cast.position]);

  // The device went on to the next song of the queue by itself.
  useEffect(() => {
    if (!cast.casting || !cast.trackId) return;
    const i = queueRef.current.findIndex((t) => t.id === cast.trackId);
    if (i >= 0 && i !== indexRef.current) {
      fromDevice.current = cast.trackId;
      setIndex(i);
    }
  }, [cast.casting, cast.trackId]);

  const next = useCallback(() => setIndex((i) => (i + 1 < queue.length ? i + 1 : i)), [queue.length]);
  const prev = useCallback(() => {
    if (castRef.current.casting) {
      if (castRef.current.position > 3) castSeek(0);
      else setIndex((i) => Math.max(0, i - 1));
    } else if ((audio.current?.currentTime ?? 0) > 3) audio.current!.currentTime = 0;
    else setIndex((i) => Math.max(0, i - 1));
  }, []);
  const toggle = useCallback(() => {
    if (castRef.current.casting) return castPlayPause();
    const el = audio.current!;
    if (el.paused) void el.play();
    else el.pause();
  }, []);
  const seek = useCallback((s: number) => {
    if (castRef.current.casting) castSeek(s);
    else audio.current!.currentTime = s;
  }, []);
  const close = useCallback(() => {
    if (castRef.current.casting) stopCastSession();
    const el = audio.current!;
    el.pause();
    el.removeAttribute("src");
    el.load();
    setQueue([]);
    setIndex(-1);
    setPosition(0);
    setDuration(0);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  }, []);
  const play = useCallback((q: Track[], i: number) => {
    setQueue(q);
    setIndex(i);
  }, []);

  // Lock-screen / browser media controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!current) return;
    const meta = { title: current.title, artist: current.artist, album: current.album };
    navigator.mediaSession.metadata = new MediaMetadata(meta);
    if (current.hasArt) {
      void api.mediaUrl("art", current.id, current.updatedAt).then((src) => {
        if (navigator.mediaSession.metadata?.title === meta.title) {
          navigator.mediaSession.metadata = new MediaMetadata({ ...meta, artwork: [{ src: new URL(src, location.origin).href, sizes: "600x600" }] });
        }
      });
    }
    navigator.mediaSession.setActionHandler("play", () => void audio.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.current?.pause());
    navigator.mediaSession.setActionHandler("nexttrack", next);
    navigator.mediaSession.setActionHandler("previoustrack", prev);
  }, [current, next, prev]);

  const casting = cast.casting;
  const value = useMemo(
    () => ({
      current,
      playing: casting ? cast.playing : playing,
      position: casting ? cast.position : position,
      duration: casting ? cast.duration || current?.duration || 0 : duration,
      play, toggle, next, prev, seek, close,
      cast: { available: cast.available, casting, device: cast.device, error: cast.error },
      startCast: () => void startCastSession(),
      stopCast: stopCastSession,
    }),
    [current, playing, position, duration, play, toggle, next, prev, seek, close, casting, cast.playing, cast.position, cast.duration, cast.available, cast.device, cast.error],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio
        ref={audio}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration);
          if (resume.current > 0) e.currentTarget.currentTime = resume.current;
          resume.current = 0;
        }}
        onEnded={() => (index + 1 < queue.length ? next() : setPlaying(false))}
        onError={() => {
          // Most likely the token expired mid-song: reload the same track at the same spot.
          if (current && audio.current?.src) void load(current, audio.current.currentTime);
        }}
      />
    </Ctx.Provider>
  );
}

export function PlayerBar() {
  const p = usePlayer();
  if (!p.current) return null;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <footer className="player">
      <div className="player-info">
        <Cover track={p.current} seed={p.current.album || p.current.title} className="md" />
        <div className="player-title">
          <strong>{p.current.title}{p.current.ai && <> <AiBadge /></>}</strong>
          <span>{[p.current.artist, p.current.album].filter(Boolean).join(" · ")}</span>
          {p.cast.casting && <span className="cast-note">Casting to {p.cast.device || "a device"}</span>}
          {p.cast.error && <span className="error" role="alert">{p.cast.error}</span>}
          <Stars trackId={p.current.id} title={p.current.title} />
        </div>
      </div>
      <div className="player-mid">
        <div className="player-controls">
          <button onClick={p.prev} aria-label="Previous">⏮</button>
          <button className="primary big" onClick={p.toggle} aria-label={p.playing ? "Pause" : "Play"}>{p.playing ? "⏸" : "▶"}</button>
          <button onClick={p.next} aria-label="Next">⏭</button>
          {p.cast.available && (
            <button
              className={p.cast.casting ? "primary" : ""}
              onClick={p.cast.casting ? p.stopCast : p.startCast}
              aria-label={p.cast.casting ? "Stop casting" : "Cast to a device"}
              title={p.cast.casting ? `Casting to ${p.cast.device}. Click to stop.` : "Cast to a device"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
              </svg>
            </button>
          )}
          <button onClick={p.close} aria-label="Close player" title="Close player">✕</button>
        </div>
        <div className="player-seek">
          <span>{fmt(p.position)}</span>
          <input type="range" min={0} max={p.duration || 1} step={1} value={Math.min(p.position, p.duration || 1)} onChange={(e) => p.seek(Number(e.target.value))} />
          <span>{fmt(p.duration || 0)}</span>
        </div>
      </div>
      {p.current.artist && <ArtistPic name={p.current.artist} className="xs" />}
    </footer>
  );
}
