import { useEffect, useMemo, useState } from "react";
import type { Track } from "../shared/types";
import { api } from "./api";
import { usePlayer } from "./player";

interface Guess { album: string; artist: string; confidence: number; sources: string[]; title?: string }
interface Song { id: string; title: string; artist: string }
interface Row { track: Song; guesses: Guess[]; /** index of the chosen guess, -1 for none */ pick: number; /** also take the guess's title / artist name */ retitle: boolean; reartist: boolean }

/** A guess this sure also corrects the title and artist by default, when they differ. */
const SURE = 0.95;
/** Suggestions are shown a dozen at a time so each batch is easy to go through. */
const PAGE = 12;
const titleDiffers = (g: Guess | undefined, t: Song) => !!g?.title && g.title !== t.title;
const artistDiffers = (g: Guess | undefined, t: Song) => !!g?.artist && g.artist !== t.artist;
const names = (g: Guess | undefined, t: Song) => ({
  retitle: titleDiffers(g, t) && g!.confidence >= SURE,
  reartist: artistDiffers(g, t) && g!.confidence >= SURE,
});

const asRow = (track: Song, guesses: Guess[]): Row => ({ track, guesses, pick: 0, ...names(guesses[0], track) });

/**
 * Owner tool: finds an album for songs that have none, from online catalogues and the file's audio fingerprint, and
 * lists the candidates with a confidence for each. The server also looks every night and saves what it finds here.
 * Nothing is written until the owner confirms, unless auto-apply is switched on (two sources agreeing at 95% or more).
 */
export function MissingAlbums({ tracks, refresh }: { tracks: Track[]; refresh: () => Promise<void> }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [soundNote, setSoundNote] = useState("");
  const [auto, setAuto] = useState(false);
  const [none, setNone] = useState(0);
  const [bySure, setBySure] = useState(false);
  const [page, setPage] = useState(0);
  const player = usePlayer();
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  /** What the nightly run saved; songs already in the list keep the choice made on them. */
  const loadSaved = async () => {
    try {
      const s = await api.albumsSaved();
      setAuto(s.autoApply);
      setNone(s.none + s.dismissed);
      setRows((old) => {
        const have = new Set(old.map((r) => r.track.id));
        return [...old, ...s.items.filter((i) => !have.has(i.id)).map((i) => asRow(i, i.guesses))];
      });
    } catch {
      /* the button below still works */
    }
  };
  useEffect(() => { void loadSaved(); }, []);

  const find = async () => {
    setBusy(true);
    setSoundNote("");
    let missing: { id: string; title: string; artist: string; duration: number }[];
    try {
      setMsg("Finding songs without an album…");
      missing = (await api.albumsMissing()).items;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not load the library");
      setBusy(false);
      return;
    }
    const found: Row[] = [];
    try {
      for (let i = 0; i < missing.length; i += 5) {
        setMsg(`Looking up albums online… ${i} of ${missing.length} songs`);
        const batch = missing.slice(i, i + 5);
        const { results, soundNote: note } = await api.suggestAlbums(batch.map((t) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration })));
        if (note) setSoundNote(note);
        const by = new Map(results.map((r) => [r.id, r.guesses]));
        for (const t of batch) {
          const guesses = by.get(t.id) ?? [];
          if (guesses.length) found.push(asRow(t, guesses));
        }
      }
      setMsg(
        found.length
          ? `${found.length} of ${missing.length} songs have a suggested album. Check each one, then apply.`
          : missing.length
            ? `No album found online for the ${missing.length} songs without one.`
            : "Every song has an album.",
      );
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : "The lookup failed"} (${found.length} found before that).`);
    }
    setRows((old) => [...found, ...old.filter((o) => !found.some((f) => f.track.id === o.track.id))]);
    setBusy(false);
  };

  const top = (r: Row) => r.guesses[0]?.confidence ?? 0;
  const sorted = bySure ? [...rows].sort((a, b) => top(b) - top(a)) : rows;
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = sorted.slice(at * PAGE, (at + 1) * PAGE);
  const chosen = shown.filter((r) => r.pick >= 0);
  const skipped = shown.filter((r) => r.pick < 0);

  const apply = async () => {
    setBusy(true);
    const done = new Set<string>();
    const failed: string[] = [];
    for (const r of chosen) {
      setMsg(`Saving albums… ${done.size + 1} of ${chosen.length}`);
      try {
        const g = r.guesses[r.pick]!;
        await api.editTrack(r.track.id, { album: g.album, ...(r.retitle && g.title ? { title: g.title } : {}), ...(r.reartist && g.artist ? { artist: g.artist } : {}) });
        done.add(r.track.id);
      } catch (e) {
        failed.push(`${r.track.title}: ${e instanceof Error ? e.message : "failed"}`);
        if (e instanceof Error && /busy|right now/i.test(e.message)) break;
      }
    }
    try {
      if (done.size) await api.resolveAlbums({ status: "applied", ids: [...done] });
      await refresh();
    } catch {
      /* the list below is still right */
    }
    setRows((rs) => rs.filter((r) => !done.has(r.track.id)));
    setMsg(`Done: ${done.size} song${done.size === 1 ? "" : "s"} got an album.` + (failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).join("; ")}.` : ""));
    setBusy(false);
  };

  /** "None of these": the songs are not offered again by the nightly run. */
  const dismiss = async () => {
    const ids = skipped.map((r) => r.track.id);
    setBusy(true);
    try {
      await api.resolveAlbums({ status: "dismissed", ids });
      setRows((rs) => rs.filter((r) => !ids.includes(r.track.id)));
      setNone((n) => n + ids.length);
      setMsg(`${ids.length} song${ids.length === 1 ? "" : "s"} will not be suggested again.`);
    } catch (e) {
      setMsg(`Could not save that: ${e instanceof Error ? e.message : "failed"}`);
    }
    setBusy(false);
  };

  const retry = async () => {
    setBusy(true);
    try {
      await api.resolveAlbums({ status: "retry" });
      setNone(0);
      setMsg("They will be looked up again tonight, or press Find albums online now.");
    } catch (e) {
      setMsg(`Could not save that: ${e instanceof Error ? e.message : "failed"}`);
    }
    setBusy(false);
  };

  const toggleAuto = async (on: boolean) => {
    setAuto(on);
    try {
      await api.albumSettings(on);
    } catch (e) {
      setAuto(!on);
      setMsg(`Could not save that: ${e instanceof Error ? e.message : "failed"}`);
    }
  };

  /** Plays a song; the library page may not hold it yet, so it is fetched when it is missing. */
  const listen = async (id: string) => {
    if (player.current?.id === id) return player.toggle();
    try {
      const t = byId.get(id) ?? (await api.tracksByIds([id])).tracks[0];
      if (t) player.play([t], 0);
      else setMsg("Could not load that song to play it.");
    } catch (e) {
      setMsg(`Could not play that: ${e instanceof Error ? e.message : "failed"}`);
    }
  };

  const missingCount = tracks.filter((t) => !t.deleted && /^(\[unknown album\])?$/i.test(t.album.trim())).length;
  return (
    <section className="tool">
      <h3>Find missing albums</h3>
      <p className="muted">
        Looks up songs that have no album in iTunes, Deezer and Discogs, and listens to the file (an audio fingerprint, checked on
        AcoustID) when it is on the home server, then suggests the albums with a confidence for each. The server also does this
        every night and keeps the suggestions here. Nothing changes until you confirm.{missingCount ? ` ${missingCount} songs here have no album.` : ""}
      </p>
      <p><button onClick={() => void find()} disabled={busy}>Find albums online now</button></p>
      <label className="albumfind-opt">
        <input type="checkbox" checked={auto} disabled={busy} onChange={(e) => void toggleAuto(e.target.checked)} />
        <span className="grow">Apply automatically at night when two sources agree at 95% or more (otherwise it only suggests)</span>
      </label>
      {none > 0 && <p className="muted">Nothing was found for {none} songs. <button className="link" disabled={busy} onClick={() => void retry()}>Look for them again</button></p>}
      {msg && <p className={/failed|could not/i.test(msg) ? "error" : "muted"} role="status">{busy && <span className="spinner" />}{msg}</p>}
      {soundNote && <p className="muted">The sound lookup was skipped: {soundNote}</p>}
      {rows.length > 0 && (
        <>
          <p className="fixv-bar">
            <strong>{rows.length} suggestions · showing {at * PAGE + 1}–{at * PAGE + shown.length} · {chosen.length} selected</strong>
            <button className="link" onClick={() => { setBySure((v) => !v); setPage(0); }}>{bySure ? "Sort by artist" : "Sort by confidence"}</button>
            {chosen.length > 0 && (
              <button className="link" disabled={busy} onClick={() => setRows((rs) => rs.map((r) => (shown.includes(r) ? { ...r, pick: -1 } : r)))}>Set these to “none of these”</button>
            )}
            {skipped.length > 0 && <button className="link" disabled={busy} onClick={() => void dismiss()}>Never suggest the {skipped.length} marked “none”</button>}
            <button className="primary" disabled={busy || chosen.length === 0} onClick={() => void apply()}>Apply {chosen.length} albums</button>
          </p>
          <ul className="fixv-list albumfind">
            {shown.map((r) => {
              const patch = (p: Partial<Row>) => setRows((rs) => rs.map((x) => (x.track.id === r.track.id ? { ...x, ...p } : x)));
              const g = r.pick >= 0 ? r.guesses[r.pick] : undefined;
              return (
                <li key={r.track.id} className={r.pick >= 0 ? "picked" : ""}>
                  {(
                    <button
                      className="albumfind-play"
                      aria-label={player.current?.id === r.track.id && player.playing ? `Pause ${r.track.title}` : `Play ${r.track.title}`}
                      title="Listen to this song"
                      onClick={() => void listen(r.track.id)}
                    >
                      {player.current?.id === r.track.id && player.playing ? "❚❚" : "▶"}
                    </button>
                  )}
                  <div className="fixv-names">
                    <strong>{r.track.title}</strong>
                    <small className="muted">{r.track.artist}</small>
                    {r.guesses.map((x, gi) => (
                      <label key={x.album} className="albumfind-opt">
                        <input type="radio" name={`album-${r.track.id}`} checked={r.pick === gi} disabled={busy} onChange={() => patch({ pick: gi, ...names(x, r.track) })} />
                        <span className="grow">{x.album}</span>
                        <small className="muted" title={`Found on ${x.sources.join(" and ")}`}>{Math.round(x.confidence * 100)}%</small>
                      </label>
                    ))}
                    {titleDiffers(g, r.track) && (
                      <label className="albumfind-opt">
                        <input type="checkbox" checked={r.retitle} disabled={busy} onChange={(e) => patch({ retitle: e.target.checked })} />
                        <span className="grow">Also rename the title to “{g!.title}”</span>
                      </label>
                    )}
                    {artistDiffers(g, r.track) && (
                      <label className="albumfind-opt">
                        <input type="checkbox" checked={r.reartist} disabled={busy} onChange={(e) => patch({ reartist: e.target.checked })} />
                        <span className="grow">Also change the artist to “{g!.artist}”</span>
                      </label>
                    )}
                    <label className="albumfind-opt">
                      <input type="radio" name={`album-${r.track.id}`} checked={r.pick === -1} disabled={busy} onChange={() => patch({ pick: -1 })} />
                      <span className="grow muted">None of these</span>
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <p className="fixv-bar">
              <button disabled={busy || at === 0} onClick={() => setPage(at - 1)}>Previous {PAGE}</button>
              <span className="muted">Batch {at + 1} of {pages}</span>
              <button disabled={busy || at >= pages - 1} onClick={() => setPage(at + 1)}>Next {PAGE}</button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
