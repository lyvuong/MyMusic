import { useState } from "react";
import type { Track } from "../shared/types";
import { api } from "./api";

interface Guess { album: string; artist: string; confidence: number; sources: string[]; title?: string }
interface Row { track: Track; guesses: Guess[]; /** index of the chosen guess, -1 for none */ pick: number; /** also take the title and artist of a sound match */ names: boolean }

/**
 * Owner tool: finds an album for songs that have none, from online catalogues, and lists the candidates with a
 * confidence for each. Nothing is saved until the owner confirms.
 */
export function MissingAlbums({ tracks, loadAll, refresh }: { tracks: Track[]; loadAll: () => Promise<void>; refresh: () => Promise<void> }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [soundNote, setSoundNote] = useState("");

  const find = async () => {
    setBusy(true);
    setRows(null);
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
          if (guesses.length) found.push({ track: t, guesses, pick: 0, names: false });
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
    setRows(found);
    setBusy(false);
  };

  const chosen = (rows ?? []).filter((r) => r.pick >= 0);

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
      await refresh();
    } catch {
      /* the list below is still right */
    }
    setRows((rs) => (rs ?? []).filter((r) => !done.has(r.track.id)));
    setMsg(`Done: ${done.size} song${done.size === 1 ? "" : "s"} got an album.` + (failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).join("; ")}.` : ""));
    setBusy(false);
  };

  const missingCount = tracks.filter((t) => !t.deleted && !t.album.trim()).length;
  return (
    <section className="tool">
      <h3>Find missing albums</h3>
      <p className="muted">
        Looks up songs that have no album in iTunes and Deezer, and listens to the file (an audio fingerprint, checked on
        AcoustID) when it is on the home server, then suggests the albums with a confidence for each. Nothing changes until you confirm.{missingCount ? ` ${missingCount} songs here have no album.` : ""}
      </p>
      <p><button onClick={() => void find()} disabled={busy}>{rows === null ? "Find albums online" : "Look again"}</button></p>
      {msg && <p className={/failed|could not/i.test(msg) ? "error" : "muted"} role="status">{busy && <span className="spinner" />}{msg}</p>}
      {soundNote && <p className="muted">The sound lookup was skipped: {soundNote}</p>}
      {rows !== null && rows.length > 0 && (
        <>
          <p className="fixv-bar">
            <strong>{chosen.length} selected</strong>
            <button className="primary" disabled={busy || chosen.length === 0} onClick={() => void apply()}>Apply {chosen.length} albums</button>
          </p>
          <ul className="fixv-list albumfind">
            {rows.map((r, ri) => (
              <li key={r.track.id} className={r.pick >= 0 ? "picked" : ""}>
                <div className="fixv-names">
                  <strong>{r.track.title}</strong>
                  <small className="muted">{r.track.artist}</small>
                  {r.guesses.map((g, gi) => (
                    <label key={g.album} className="albumfind-opt">
                      <input type="radio" name={`album-${r.track.id}`} checked={r.pick === gi} disabled={busy}
                        onChange={() => setRows((rs) => (rs ?? []).map((x, i) => (i === ri ? { ...x, pick: gi } : x)))} />
                      <span className="grow">{g.album}</span>
                      <small className="muted" title={`Found on ${g.sources.join(" and ")}`}>{Math.round(g.confidence * 100)}%</small>
                    </label>
                  ))}
                  {r.pick >= 0 && r.guesses[r.pick]!.title && (r.guesses[r.pick]!.title !== r.track.title || r.guesses[r.pick]!.artist !== r.track.artist) && (
                    <label className="albumfind-opt">
                      <input type="checkbox" checked={r.names} disabled={busy}
                        onChange={(e) => setRows((rs) => (rs ?? []).map((x, i) => (i === ri ? { ...x, names: e.target.checked } : x)))} />
                      <span className="grow">Also rename to “{r.guesses[r.pick]!.title}” by {r.guesses[r.pick]!.artist}</span>
                    </label>
                  )}
                  <label className="albumfind-opt">
                    <input type="radio" name={`album-${r.track.id}`} checked={r.pick === -1} disabled={busy}
                      onChange={() => setRows((rs) => (rs ?? []).map((x, i) => (i === ri ? { ...x, pick: -1 } : x)))} />
                    <span className="grow muted">None of these</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
