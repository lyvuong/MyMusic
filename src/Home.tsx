import { useCallback, useEffect, useMemo, useState } from "react";
import type { HomeData, MixInfo, Track } from "../shared/types";
import { api } from "./api";
import { AlbumCard, groupAlbums, songCount } from "./browse";
import { usePlayer } from "./player";
import { TrackRow } from "./TrackRow";
import type { Library } from "./useLibrary";

/** Where the start page sends the Library tab: a search, a genre, or one album. */
export interface Jump {
  n: number;
  q?: string;
  genre?: string;
  open?: { kind: "album" | "artist"; key: string };
}

const MAX_AGE_MS = 60_000;
let cache: { data: HomeData; at: number } | null = null;

/**
 * The start page's data, shared by the Home and Library tabs. It is a few hundred rows however large the library is, and
 * is reused for a minute, so moving between tabs does not ask again.
 */
export function useHome() {
  const [data, setData] = useState<HomeData | null>(cache?.data ?? null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const d = await api.home();
      cache = { data: d, at: Date.now() };
      setData(d);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, []);
  useEffect(() => {
    if (!cache || Date.now() - cache.at > MAX_AGE_MS) void reload();
  }, [reload]);
  return { data, error, reload };
}

const DAYPARTS = ["morning", "afternoon", "evening", "night"];
const NAME: Record<string, string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening", night: "Late night" };

/** The same buckets as the Android app, by the hour of the device. */
function currentDaypart(d = new Date()): string {
  const h = d.getHours();
  return h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
}

/** A named list of songs: a play button, and the first few songs that open up to the rest. */
function SongList({ title, note, tracks, highlight }: { title: string; note?: string; tracks: Track[]; highlight?: boolean }) {
  const p = usePlayer();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  if (tracks.length === 0) return null;
  return (
    <section className={`card songlist${highlight ? " now" : ""}`}>
      <div className="songlist-head">
        <div>
          <h3>{title}</h3>
          <small className="muted">{[note, songCount(tracks.length)].filter(Boolean).join(" · ")}</small>
        </div>
        <span>
          <button className="primary" onClick={() => p.play(tracks, 0)}>▶ Play</button>{" "}
          <button className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Hide songs" : "Show songs"}</button>
        </span>
      </div>
      {open && (
        <>
          <ul>{(all ? tracks : tracks.slice(0, 8)).map((t) => <TrackRow key={t.id} t={t} queue={tracks} />)}</ul>
          {!all && tracks.length > 8 && <button className="link" onClick={() => setAll(true)}>Show all {tracks.length}</button>}
        </>
      )}
    </section>
  );
}

/**
 * The start page: today's AI mixes (made overnight, so nothing is generated or read when you open the app), the newest
 * albums, a few lists and the genres. Search and genres lead to the Library tab, which shows a page at a time.
 */
export function Home({ lib, isOwner, go }: { lib: Library; isOwner: boolean; go: (j: Omit<Jump, "n">) => void }) {
  const { data, error, reload } = useHome();
  const { remember } = lib;
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) remember([...data.recent, ...data.tracks]);
  }, [data, remember]);

  const byId = useMemo(() => new Map((data ? [...data.recent, ...data.tracks] : []).map((t) => [t.id, t])), [data]);
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((t): t is Track => !!t);
  const albums = useMemo(() => groupAlbums(data?.recent ?? [], true).slice(0, 12), [data]);

  const now = currentDaypart();
  const mixes = useMemo(() => {
    const by = new Map((data?.mixes ?? []).map((m) => [m.daypart, m]));
    const order = [now, ...DAYPARTS.filter((d) => d !== now)];
    return order.map((d) => by.get(d)).filter((m): m is MixInfo => !!m && m.trackIds.length > 0);
  }, [data, now]);
  // The themed hours (Vietnamese, pop, love songs, ...), in the order the server ranked them.
  const themed = useMemo(() => (data?.mixes ?? []).filter((m) => m.daypart.startsWith("theme-") && m.trackIds.length > 0), [data]);

  const makeMixes = async () => {
    setBusy(true);
    setMsg("Making your mixes… this takes about half a minute.");
    try {
      const r = await api.refreshMixes();
      setMsg(r.saved > 0 ? "" : "Rate a few songs first: the mixes are built from your ratings.");
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not make the mixes");
    } finally {
      setBusy(false);
    }
  };

  const findCovers = async () => {
    setBusy(true);
    let found = 0;
    try {
      for (let left = 1; left > 0; ) {
        setMsg(`Looking up covers… ${found} found`);
        const r = await api.fetchArt();
        found += r.updated;
        left = r.remaining;
      }
      setMsg(`Done: ${found} new cover${found === 1 ? "" : "s"}.`);
      await lib.refresh();
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Cover lookup failed");
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="muted" role="status">{error || "Loading…"}</p>;

  return (
    <div className="wide home">
      <form className="search-box" onSubmit={(e) => { e.preventDefault(); go({ q: q.trim() }); }}>
        <input className="search" placeholder="Search songs, artists, albums" enterKeyHint="search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="primary" disabled={!q.trim()}>Search</button>
      </form>
      {data.songs === 0 ? (
        <div className="empty"><p><strong>No songs yet</strong></p><p className="muted">{isOwner ? "Add songs from YouTube or the NAS inbox in Library tools." : "The family owner adds the music. Check back soon."}</p></div>
      ) : (
        <>
          {msg && <p className="muted" role="status">{busy && <span className="spinner" />}{msg}</p>}
          <h2>Made for you</h2>
          {mixes.length === 0 ? (
            <p className="muted">
              Your mixes are made overnight from your ratings and what the family plays.{" "}
              <button className="link" disabled={busy} onClick={() => void makeMixes()}>Make my mixes now</button>
            </p>
          ) : (
            mixes.map((m) => <SongList key={m.daypart} title={m.title || `${NAME[m.daypart]} mix`} note={m.daypart === now ? `${NAME[m.daypart]} · for now` : NAME[m.daypart]} tracks={pick(m.trackIds)} highlight={m.daypart === now} />)
          )}
          {mixes.length > 0 && (
            <p className="muted">
              <button className="link" disabled={busy} onClick={() => void makeMixes()}>Make my mixes again now</button>
            </p>
          )}

          {themed.length > 0 && (
            <>
              <h2>Mixes for every mood</h2>
              {themed.map((m) => <SongList key={m.daypart} title={m.title} note={m.intro} tracks={pick(m.trackIds)} />)}
            </>
          )}

          {albums.length > 0 && (
            <section>
              <h2>Recently added</h2>
              <div className="strip">
                {albums.map((a) => <AlbumCard key={a.key} album={a} onOpen={() => go({ open: { kind: "album", key: a.key } })} />)}
              </div>
              <p><button className="link" onClick={() => go({})}>Browse the library →</button></p>
            </section>
          )}

          <SongList title="Most played by the family" note="last 3 months" tracks={pick(data.lists.popular)} />
          <SongList title="Your favourites" note="rated 4–5 stars" tracks={pick(data.lists.top)} />
          <SongList title="Rediscover" note="loved, not played for a while" tracks={pick(data.lists.rediscover)} />

          {data.genres.length > 0 && (
            <section>
              <h2>Genres</h2>
              <div className="seg wrap">
                {data.genres.slice(0, 24).map((g) => <button key={g.name} onClick={() => go({ genre: g.name })}>{g.name} <small>{g.count}</small></button>)}
              </div>
            </section>
          )}

          {isOwner && data.missingCovers > 0 && (
            <p className="muted">
              {data.missingCovers} uploaded song{data.missingCovers === 1 ? " has" : "s have"} no cover. <button className="link" disabled={busy} onClick={() => void findCovers()}>Find missing covers online</button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
