import { useCallback, useEffect, useRef, useState } from "react";
import type { Playlist, Track } from "../shared/types";
import { api } from "./api";

/**
 * What the page knows about the family library. It does not load the songs up front (a library is thousands of them, and
 * every one is a database row): the playlists and the clock come first, songs arrive as the page shows them (browse,
 * home, a playlist) and are kept here by id, and after that only the songs that changed are fetched.
 */
export function useLibrary(enabled: boolean) {
  const [tracks, setTracks] = useState<Map<string, Track>>(new Map());
  const [playlists, setPlaylists] = useState<Map<string, Playlist>>(new Map());
  const [loading, setLoading] = useState(false);
  const since = useRef(0);
  const asked = useRef(new Set<string>());
  /** Bumped when songs changed, so lists built from search results know to look again. */
  const [version, setVersion] = useState(0);

  const apply = useCallback((incoming: Track[], onlyKnown: boolean) => {
    if (incoming.length === 0) return;
    setTracks((old) => {
      const m = new Map(old);
      for (const t of incoming) {
        if (t.deleted) m.delete(t.id);
        else if (!onlyKnown || m.has(t.id)) m.set(t.id, t);
      }
      return m;
    });
  }, []);

  /** Playlists and the songs that changed since the last call. The first call only learns the time. */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const first = since.current === 0;
      const d = await api.library(since.current, !first);
      since.current = d.now;
      if (!first && d.tracks.length > 0) {
        apply(d.tracks, true);
        setVersion((v) => v + 1);
      }
      setPlaylists((old) => {
        const m = new Map(old);
        for (const p of d.playlists) p.deleted ? m.delete(p.id) : m.set(p.id, p);
        return m;
      });
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  /** Keeps songs that came with a search, the home page or a playlist. */
  const remember = useCallback((ts: Track[]) => apply(ts, false), [apply]);

  /** Fetches the songs with these ids that are not known yet (playlists and mixes only hold ids). */
  const ensure = useCallback(async (ids: string[]) => {
    const need = [...new Set(ids)].filter((id) => !asked.current.has(id));
    need.forEach((id) => asked.current.add(id));
    for (let i = 0; i < need.length; i += 100) {
      try {
        apply((await api.tracksByIds(need.slice(i, i + 100))).tracks, false);
      } catch {
        need.slice(i, i + 100).forEach((id) => asked.current.delete(id));
      }
    }
  }, [apply]);

  /** The whole library, for owner tools that look at every name (the Vietnamese name fixer). */
  const loadAll = useCallback(async () => {
    const d = await api.library(0, true);
    since.current = d.now;
    setTracks(new Map(d.tracks.filter((t) => !t.deleted).map((t) => [t.id, t])));
    setVersion((v) => v + 1);
  }, []);

  return { tracks, playlists, loading, refresh, remember, ensure, loadAll, version };
}

export type Library = ReturnType<typeof useLibrary>;
