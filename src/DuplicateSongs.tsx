import { useState } from "react";
import type { DupGroup, DupSong } from "../shared/types";
import { api } from "./api";
import { usePlayer } from "./player";

/** Groups are shown a few at a time so a page can be checked at a glance. */
const PAGE = 10;
/** The choice made for a group: the id of the copy to keep, or null to leave the group alone. */
type Pick = string | null;

const length = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * Owner tool: lists songs the library holds more than once (same title and artist, about the same length), suggests the
 * copy to keep and, when confirmed, deletes the other copies' files for good. Playlist places and ratings move to the kept copy.
 */
export function DuplicateSongs({ refresh }: { refresh: () => Promise<void> }) {
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const player = usePlayer();

  const keyOf = (g: DupGroup) => g.songs[0]!.id;
  const find = async () => {
    setBusy(true);
    setMsg("Looking for duplicate songs…");
    try {
      const { groups: found } = await api.duplicates();
      setGroups(found);
      setPicks(Object.fromEntries(found.map((g) => [keyOf(g), g.keep])));
      setPage(0);
      setMsg(found.length ? `${found.length} songs are in the library more than once.` : "No duplicate songs found.");
    } catch (e) {
      setMsg(`Could not look: ${e instanceof Error ? e.message : "failed"}`);
    }
    setBusy(false);
  };

  const pages = Math.max(1, Math.ceil((groups?.length ?? 0) / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = (groups ?? []).slice(at * PAGE, (at + 1) * PAGE);
  const doomed = (g: DupGroup) => (picks[keyOf(g)] ? g.songs.filter((s) => s.id !== picks[keyOf(g)]) : []);
  const extra = shown.reduce((n, g) => n + doomed(g).length, 0);

  const remove = async () => {
    const batch = shown.filter((g) => doomed(g).length).map((g) => ({ keep: picks[keyOf(g)]!, remove: doomed(g).map((s) => s.id) }));
    if (!batch.length) return;
    if (!confirm(`Permanently delete ${extra} file${extra === 1 ? "" : "s"} from the home server? This cannot be undone.`)) return;
    setBusy(true);
    setMsg(`Deleting ${extra} file${extra === 1 ? "" : "s"}…`);
    try {
      const r = await api.resolveDuplicates(batch);
      const gone = new Set(r.removed);
      setGroups((gs) => (gs ?? [])
        .map((g) => ({ ...g, songs: g.songs.filter((s) => !gone.has(s.id)) }))
        .filter((g) => g.songs.length > 1));
      const why = r.failed.slice(0, 3).map((f) => f.why).join("; ");
      setMsg(`Deleted ${r.removed.length} cop${r.removed.length === 1 ? "y" : "ies"}.` + (r.failed.length ? ` Could not delete ${r.failed.length}: ${why}.` : ""));
      await refresh().catch(() => undefined);
    } catch (e) {
      setMsg(`Could not delete: ${e instanceof Error ? e.message : "failed"}`);
    }
    setBusy(false);
  };

  const listen = async (s: DupSong) => {
    if (player.current?.id === s.id) return player.toggle();
    try {
      const t = (await api.tracksByIds([s.id])).tracks[0];
      if (t) player.play([t], 0);
      else setMsg("Could not load that song to play it.");
    } catch (e) {
      setMsg(`Could not play that: ${e instanceof Error ? e.message : "failed"}`);
    }
  };

  return (
    <section className="tool">
      <h3>Find duplicate songs</h3>
      <p className="muted">
        Lists songs that are in the library more than once (same title and artist, about the same length), for example one on an album and
        one on a greatest-hits. The copy you keep is suggested: one that is in a playlist, rated or played, then one from a real album.
        The other copies' files are deleted from the home server for good; their playlist places and ratings move to the kept copy.
        Live, remix and much longer or shorter versions are not counted as duplicates.
      </p>
      <p><button onClick={() => void find()} disabled={busy}>{groups ? "Look again" : "Find duplicates"}</button></p>
      {msg && <p className={/could not/i.test(msg) ? "error" : "muted"} role="status">{busy && <span className="spinner" />}{msg}</p>}
      {groups && groups.length > 0 && (
        <>
          <p className="fixv-bar">
            <strong>{groups.length} songs · showing {at * PAGE + 1}–{at * PAGE + shown.length}</strong>
            <button className="primary" disabled={busy || extra === 0} onClick={() => void remove()}>Delete {extra} extra cop{extra === 1 ? "y" : "ies"}</button>
          </p>
          <ul className="fixv-list albumfind">
            {shown.map((g) => {
              const k = keyOf(g);
              return (
                <li key={k} className={picks[k] ? "picked" : ""}>
                  <div className="fixv-names">
                    <strong>{g.songs[0]!.title}</strong>
                    <small className="muted">{g.songs[0]!.artist}</small>
                    {g.songs.map((s) => (
                      <div key={s.id} className="albumfind-opt">
                        <button
                          className="albumfind-play"
                          aria-label={player.current?.id === s.id && player.playing ? `Pause ${s.title}` : `Play ${s.title}`}
                          title="Listen to this copy"
                          onClick={() => void listen(s)}
                        >
                          {player.current?.id === s.id && player.playing ? "❚❚" : "▶"}
                        </button>
                        <label className="albumfind-opt grow">
                          <input type="radio" name={`dup-${k}`} checked={picks[k] === s.id} disabled={busy} onChange={() => setPicks((p) => ({ ...p, [k]: s.id }))} />
                          <span className="grow">
                            {s.album || "(no album)"} · {length(s.duration)} · {mb(s.size)}
                            {s.lists > 0 && ` · in ${s.lists} playlist${s.lists === 1 ? "" : "s"}`}
                            {s.rating > 0 && ` · ${"★".repeat(s.rating)}`}
                            {s.plays > 0 && ` · played ${s.plays}×`}
                          </span>
                          <small className="muted">{picks[k] === s.id ? "keep" : picks[k] ? "delete" : ""}</small>
                        </label>
                      </div>
                    ))}
                    <label className="albumfind-opt">
                      <input type="radio" name={`dup-${k}`} checked={picks[k] === null} disabled={busy} onChange={() => setPicks((p) => ({ ...p, [k]: null }))} />
                      <span className="grow muted">Keep all of them</span>
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <p className="fixv-bar">
              <button disabled={busy || at === 0} onClick={() => setPage(at - 1)}>Previous {PAGE}</button>
              <span className="muted">Page {at + 1} of {pages}</span>
              <button disabled={busy || at >= pages - 1} onClick={() => setPage(at + 1)}>Next {PAGE}</button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
