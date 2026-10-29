import { useMemo, useRef, useState } from "react";
import type { AiRecheck, Track } from "../shared/types";
import { suggestAi } from "../shared/aireview";
import { api } from "./api";
import { AiBadge } from "./art";

type Mode = "suggest" | "browse" | "youtube";
/** Rows are drawn a page at a time so a big library stays quick. */
const PAGE = 50;
/** Songs asked about per request when asking YouTube again (each is a few seconds on the home server). */
const ASK = 2;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

/**
 * Owner tool: makes sure the AI badge is on the right songs. Three ways in: artists and albums that are partly marked
 * (the rest are suggested), a searchable list with bulk mark / unmark, and asking YouTube again about songs added from
 * a YouTube link. Nothing changes until the owner confirms.
 */
export function AiSongs({ tracks, refresh, loadAll }: { tracks: Track[]; refresh: () => Promise<void>; loadAll: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>("suggest");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const start = async () => {
    setOpen(true);
    if (loaded) return;
    setBusy(true);
    setMsg("Loading the library…");
    try {
      await loadAll();
      setLoaded(true);
      setMsg("");
    } catch (e) {
      setMsg(`Could not load the library: ${e instanceof Error ? e.message : "failed"}`);
    }
    setBusy(false);
  };

  /** Sets or clears the badge for these songs, then refreshes the app's copy of the library. */
  const apply = async (ids: string[], ai: boolean): Promise<boolean> => {
    if (!ids.length) return false;
    setBusy(true);
    setMsg(`${ai ? "Marking" : "Clearing"} ${ids.length} song${ids.length === 1 ? "" : "s"}…`);
    try {
      let changed = 0;
      for (let i = 0; i < ids.length; i += 200) changed += (await api.setAi(ids.slice(i, i + 200), ai)).changed;
      await refresh().catch(() => undefined);
      setMsg(changed ? `${ai ? "Marked" : "Cleared"} ${changed} song${changed === 1 ? "" : "s"}.` : "Nothing needed changing.");
      setBusy(false);
      return true;
    } catch (e) {
      setMsg(`Could not save: ${e instanceof Error ? e.message : "failed"}`);
      setBusy(false);
      return false;
    }
  };

  return (
    <section className="tool">
      <h3>Review AI songs</h3>
      <p className="muted">
        Makes sure the AI badge is on the songs made by AI. Mark songs in bulk, let it suggest the rest of an artist or album you have
        already marked, or ask YouTube again about songs that were added from a YouTube link.
      </p>
      {!open ? (
        <p><button onClick={() => void start()} disabled={busy}>Review AI songs</button></p>
      ) : (
        <>
          <p className="fixv-bar">
            {([["suggest", "Suggestions"], ["browse", "Pick songs"], ["youtube", "Ask YouTube"]] as [Mode, string][]).map(([m, label]) => (
              <button key={m} className={mode === m ? "primary" : ""} disabled={busy || !loaded} onClick={() => { setMode(m); setMsg(""); }}>{label}</button>
            ))}
          </p>
          {msg && <p className={/could not/i.test(msg) ? "error" : "muted"} role="status">{busy && <span className="spinner" />}{msg}</p>}
          {loaded && mode === "suggest" && <Suggestions tracks={tracks} busy={busy} apply={apply} />}
          {loaded && mode === "browse" && <Browse tracks={tracks} busy={busy} apply={apply} />}
          {loaded && mode === "youtube" && <AskYoutube tracks={tracks} busy={busy} apply={apply} setBusy={setBusy} setMsg={setMsg} />}
        </>
      )}
    </section>
  );
}

interface Pane { tracks: Track[]; busy: boolean; apply: (ids: string[], ai: boolean) => Promise<boolean> }

/** Artists and albums that are partly marked: the unmarked songs are offered, those mostly marked already ticked. */
function Suggestions({ tracks, busy, apply }: Pane) {
  const found = useMemo(() => suggestAi(tracks), [tracks]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [on, setOn] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const key = (s: (typeof found)[number]) => `${s.kind}\u0000${s.name}`;
  const ticked = (s: (typeof found)[number]) => (s.likely ? !off.has(key(s)) : on.has(key(s)));
  const toggle = (s: (typeof found)[number]) => {
    const flip = (set: Set<string>) => { const n = new Set(set); n.has(key(s)) ? n.delete(key(s)) : n.add(key(s)); return n; };
    if (s.likely) setOff(flip); else setOn(flip);
  };
  const ids = [...new Set(found.filter(ticked).flatMap((s) => s.rest.map((t) => t.id)))];

  if (!found.length) return <p className="muted">No artist or album is partly marked as AI. Mark some songs first (Pick songs), then come back.</p>;
  return (
    <>
      <p className="muted">These artists and albums have some songs marked as AI and some not. Ticked ones are mostly AI already.</p>
      <p className="fixv-bar">
        <strong>{found.length} to look at</strong>
        <button className="primary" disabled={busy || ids.length === 0} onClick={() => void apply(ids, true).then((ok) => ok && (setOff(new Set()), setOn(new Set())))}>
          Mark {ids.length} song{ids.length === 1 ? "" : "s"} as AI
        </button>
      </p>
      <ul className="fixv-list">
        {found.slice(0, shown).map((s) => (
          <li key={key(s)} className={ticked(s) ? "picked" : ""}>
            <label className="albumfind-opt grow">
              <input type="checkbox" checked={ticked(s)} disabled={busy} onChange={() => toggle(s)} />
              <span className="grow">
                <strong>{s.name}</strong> <small className="muted">{s.kind} · {s.ai} of {s.total} are AI</small>
                <br />
                <small className="muted">
                  Would mark: {s.rest.slice(0, 4).map((t) => t.title).join(", ")}{s.rest.length > 4 ? ` and ${s.rest.length - 4} more` : ""}
                </small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {shown < found.length && <p><button disabled={busy} onClick={() => setShown(shown + PAGE)}>Show more</button></p>}
    </>
  );
}

/** Every song with its badge: search, tick, then mark or clear in one go. */
function Browse({ tracks, busy, apply }: Pane) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "ai" | "plain">("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => {
    const words = norm(q).split(/\s+/).filter(Boolean);
    return tracks
      .filter((t) => (filter === "all" || (filter === "ai") === t.ai) && words.every((w) => norm(`${t.title} ${t.artist} ${t.album}`).includes(w)))
      .sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || a.trackNo - b.trackNo);
  }, [tracks, q, filter]);
  const chosen = [...sel].filter((id) => tracks.some((t) => t.id === id));
  const flip = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const finish = (ai: boolean) => void apply(chosen, ai).then((ok) => ok && setSel(new Set()));

  return (
    <>
      <p className="fixv-bar">
        <input type="search" placeholder="Search title, artist or album" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} />
        <select value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setShown(PAGE); }} aria-label="Show">
          <option value="all">All songs</option>
          <option value="ai">Marked as AI</option>
          <option value="plain">Not marked</option>
        </select>
      </p>
      <p className="fixv-bar">
        <strong>{rows.length} song{rows.length === 1 ? "" : "s"} · {chosen.length} ticked</strong>
        <button disabled={busy || rows.length === 0} onClick={() => setSel(new Set(rows.map((t) => t.id)))}>Tick all {rows.length}</button>
        <button disabled={busy || chosen.length === 0} onClick={() => setSel(new Set())}>Untick</button>
        <button className="primary" disabled={busy || chosen.length === 0} onClick={() => finish(true)}>Mark as AI</button>
        <button disabled={busy || chosen.length === 0} onClick={() => finish(false)}>Remove AI</button>
      </p>
      <ul className="fixv-list">
        {rows.slice(0, shown).map((t) => (
          <li key={t.id} className={sel.has(t.id) ? "picked" : ""}>
            <label className="albumfind-opt grow">
              <input type="checkbox" checked={sel.has(t.id)} disabled={busy} onChange={() => flip(t.id)} />
              <span className="grow">
                {t.title}{t.ai && <> <AiBadge /></>}
                <br /><small className="muted">{t.artist} · {t.album || "(no album)"}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {shown < rows.length && <p><button disabled={busy} onClick={() => setShown(shown + PAGE)}>Show more</button></p>}
    </>
  );
}

/** Songs added from a YouTube link are looked up again; the ones YouTube labels as AI (or that mention it) can be marked. */
function AskYoutube({ tracks, busy, apply, setBusy, setMsg }: Pane & { setBusy: (b: boolean) => void; setMsg: (m: string) => void }) {
  const [found, setFound] = useState<(AiRecheck & { track: Track })[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const stop = useRef(false);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  const ask = async () => {
    setBusy(true);
    stop.current = false;
    setFound([]);
    setSel(new Set());
    setMsg("Finding songs added from YouTube…");
    try {
      const todo = (await api.aiSources()).ids.filter((id) => byId.has(id) && !byId.get(id)!.ai);
      if (!todo.length) {
        setMsg("Every song added from YouTube is marked already, or none has a known link.");
        setBusy(false);
        return;
      }
      let failed = 0, done = 0;
      const hits: (AiRecheck & { track: Track })[] = [];
      for (let i = 0; i < todo.length && !stop.current; i += ASK) {
        setMsg(`Asking YouTube… ${done} of ${todo.length} (${hits.length} look like AI)`);
        const { results } = await api.recheckAi(todo.slice(i, i + ASK));
        for (const r of results) {
          done++;
          if (r.error) failed++;
          else if (r.label || r.hint) hits.push({ ...r, track: byId.get(r.id)! });
        }
        setFound([...hits]);
        setSel(new Set(hits.map((h) => h.id)));
      }
      setMsg(`${stop.current ? "Stopped after" : "Checked"} ${done} of ${todo.length} songs: ${hits.length} look like AI.` + (failed ? ` ${failed} could not be read.` : ""));
    } catch (e) {
      setMsg(`Could not ask YouTube: ${e instanceof Error ? e.message : "failed"}`);
    }
    setBusy(false);
  };

  const chosen = (found ?? []).filter((h) => sel.has(h.id)).map((h) => h.id);
  return (
    <>
      <p className="muted">
        Looks up the video of every song added from YouTube that is not marked, and lists the ones YouTube labels "Made with AI" or whose
        description mentions AI (Suno, Udio…). It takes a few seconds per song. Only songs added since the YouTube link was kept are covered.
      </p>
      <p className="fixv-bar">
        <button onClick={() => void ask()} disabled={busy}>{found ? "Ask again" : "Ask YouTube"}</button>
        {busy && <button onClick={() => { stop.current = true; }}>Stop</button>}
        {found && found.length > 0 && (
          <button className="primary" disabled={busy || chosen.length === 0} onClick={() => void apply(chosen, true).then((ok) => ok && setFound((f) => (f ?? []).filter((h) => !sel.has(h.id))))}>
            Mark {chosen.length} as AI
          </button>
        )}
      </p>
      <ul className="fixv-list">
        {(found ?? []).map((h) => (
          <li key={h.id} className={sel.has(h.id) ? "picked" : ""}>
            <label className="albumfind-opt grow">
              <input type="checkbox" checked={sel.has(h.id)} disabled={busy} onChange={() => setSel((s) => { const n = new Set(s); n.has(h.id) ? n.delete(h.id) : n.add(h.id); return n; })} />
              <span className="grow">
                {h.track.title}
                <br /><small className="muted">{h.track.artist} · {h.label ? "YouTube labels this video as made with AI" : "the video's description mentions AI"}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}
