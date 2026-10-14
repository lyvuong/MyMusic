import { useEffect, useState } from "react";
import type { Track } from "../shared/types";
import { api } from "./api";

interface Guess { album: string; artist: string; confidence: number; sources: string[]; title?: string }
interface Song { id: string; title: string; artist: string }
interface Row { track: Song; guesses: Guess[]; /** index of the chosen guess, -1 for none */ pick: number; /** also take the title and artist of a sound match */ names: boolean }

const asRow = (track: Song, guesses: Guess[]): Row => ({ track, guesses, pick: 0, names: false });

/**
 * Owner tool: finds an album for songs that have none, from online catalogues and the file's audio fingerprint, and
 * lists the candidates with a confidence for each. The server also looks every night and saves what it finds here.
 * Nothing is written until the owner confirms, unless auto-apply is switched on (two sources agreeing at 95% or more).
 */
export function MissingAlbums({ tracks, loadAll, refresh }: { tracks: Track[]; loadAll: () => Promise<void>; refresh: () => Promise<void> }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [soundNote, setSoundNote] = useState("");
  const [auto, setAuto] = useState(false);
  const [none, setNone] = useState(0);

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
    try {
      setMsg("Loading the library…");
      await loadAll();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not load the library");
      setBusy(false);
      return;
    }
    const missing = tracks.filter((t) => !t.deleted && !t.album.trim() && t.artist.trim());
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

  const chosen = rows.filter((r) => r.pick >= 0);
  const skipped = rows.filter((r) => r.pick < 0);

  const apply = async () => {
    setBusy(true);
    const done = new Set<string>();
    const failed: string[] = [];
    for (const r of chosen) {
      setMsg(`Saving albums… ${done.size + 1} of ${chosen.length}`);
      try {
        const g = r.guesses[r.pick]!;
        await api.editTrack(r.track.id, { album: g.album, ...(r.names && g.title ? { title: g.title, artist: g.artist } : {}) });
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

  const missingCount = tracks.filter((t) => !t.deleted && !t.album.trim()).length;
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
            <strong>{rows.length} suggestions · {chosen.length} selected</strong>
            {skipped.length > 0 && <button className="link" disabled={busy} onClick={() => void dismiss()}>Never suggest the {skipped.length} marked “none”</button>}
            <button className="primary" disabled={busy || chosen.length === 0} onClick={() => void apply()}>Apply {chosen.length} albums</button>
          </p>
          <ul className="fixv-list albumfind">
            {rows.map((r) => {
              const patch = (p: Partial<Row>) => setRows((rs) => rs.map((x) => (x.track.id === r.track.id ? { ...x, ...p } : x)));
              const g = r.pick >= 0 ? r.guesses[r.pick] : undefined;
              return (
                <li key={r.track.id} className={r.pick >= 0 ? "picked" : ""}>
                  <div className="fixv-names">
                    <strong>{r.track.title}</strong>
                    <small className="muted">{r.track.artist}</small>
                    {r.guesses.map((x, gi) => (
                      <label key={x.album} className="albumfind-opt">
                        <input type="radio" name={`album-${r.track.id}`} checked={r.pick === gi} disabled={busy} onChange={() => patch({ pick: gi })} />
                        <span className="grow">{x.album}</span>
                        <small className="muted" title={`Found on ${x.sources.join(" and ")}`}>{Math.round(x.confidence * 100)}%</small>
                      </label>
                    ))}
                    {g?.title && (g.title !== r.track.title || g.artist !== r.track.artist) && (
                      <label className="albumfind-opt">
                        <input type="checkbox" checked={r.names} disabled={busy} onChange={(e) => patch({ names: e.target.checked })} />
                        <span className="grow">Also rename to “{g.title}” by {g.artist}</span>
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
        </>
      )}
    </section>
  );
}
