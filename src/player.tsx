import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Track } from "../shared/types";
import { api } from "./api";
import { ArtistPic, Cover } from "./art";
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

  const load = useCallback(async (t: Track, startAt = 0) => {
    const el = audio.current!;
    resume.current = startAt;
    el.src = await api.mediaUrl("stream", t.id);
    try {
      await el.play();
    } catch {
      /* autoplay blocked or superseded */
    }
  }, []);

  useEffect(() => {
    if (current) void load(current);
  }, [current, load]);

  const next = useCallback(() => setIndex((i) => (i + 1 < queue.length ? i + 1 : i)), [queue.length]);
  const prev = useCallback(() => {
    if ((audio.current?.currentTime ?? 0) > 3) audio.current!.currentTime = 0;
    else setIndex((i) => Math.max(0, i - 1));
  }, []);
  const toggle = useCallback(() => {
    const el = audio.current!;
    if (el.paused) void el.play();
    else el.pause();
  }, []);
  const seek = useCallback((s: number) => {
    audio.current!.currentTime = s;
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
      void api.mediaUrl("art", current.id).then((src) => {
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

  const value = useMemo(
    () => ({ current, playing, position, duration, play, toggle, next, prev, seek }),
    [current, playing, position, duration, play, toggle, next, prev, seek],
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
          <strong>{p.current.title}</strong>
          <span>{[p.current.artist, p.current.album].filter(Boolean).join(" · ")}</span>
          <Stars trackId={p.current.id} title={p.current.title} />
        </div>
      </div>
      <div className="player-mid">
        <div className="player-controls">
          <button onClick={p.prev} aria-label="Previous">⏮</button>
          <button className="primary big" onClick={p.toggle} aria-label={p.playing ? "Pause" : "Play"}>{p.playing ? "⏸" : "▶"}</button>
          <button onClick={p.next} aria-label="Next">⏭</button>
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
