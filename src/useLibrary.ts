import { useCallback, useEffect, useRef, useState } from "react";
import type { Playlist, Track } from "../shared/types";
import { api } from "./api";

/** The family library, loaded once and then refreshed by delta (`since`). */
export function useLibrary(enabled: boolean) {
  const [tracks, setTracks] = useState<Map<string, Track>>(new Map());
  const [playlists, setPlaylists] = useState<Map<string, Playlist>>(new Map());
  const [loading, setLoading] = useState(false);
  const since = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.library(since.current);
      since.current = d.now;
      setTracks((old) => {
        const m = new Map(old);
        for (const t of d.tracks) t.deleted ? m.delete(t.id) : m.set(t.id, t);
        return m;
      });
      setPlaylists((old) => {
        const m = new Map(old);
        for (const p of d.playlists) p.deleted ? m.delete(p.id) : m.set(p.id, p);
        return m;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { tracks, playlists, loading, refresh };
}
