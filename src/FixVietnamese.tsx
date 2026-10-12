import { useRef, useState } from "react";
import type { Track } from "../shared/types";
import { cleanVietnamese, fold, hasVietnamese, maybeNeedsAccents } from "../shared/vietnamese";
import { api } from "./api";

type Kind = "album" | "artist" | "title";

interface Fix {
  id: string;
  kind: Kind;
  from: string;
  to: string;
  /** The songs that carry this name (a title is applied to each of them). */
  ids: string[];
  reason: "typed" | "case" | "accents" | "learned";
  on: boolean;
}

interface Ask { id: string; kind: Kind; from: string; ids: string[]; artist?: string; album?: string; /** Set when the AI was asked and left it as it was. */ note?: string }

const KINDS: [Kind, string][] = [["album", "Albums"], ["artist", "Artists"], ["title", "Titles"]];
const KIND_LABEL: Record<Kind, string> = { album: "Album", artist: "Artist", title: "Song" };
const REASON: Record<Fix["reason"], string> = { typed: "typed marks", case: "capitals / spacing", accents: "AI: accents", learned: "your earlier fix" };

/** Finds what the clean-up can fix by rules, and which names are worth asking the AI about. Runs in the browser. */
function scan(tracks: Track[]): { fixes: Fix[]; asks: Ask[] } {
  const live = tracks.filter((t) => !t.deleted);
  const vnArtists = new Set(live.filter((t) => hasVietnamese(t.artist)).map((t) => t.artist));
  const vnAlbums = new Set(live.filter((t) => hasVietnamese(t.album)).map((t) => t.album));
  const fixes: Fix[] = [];
  const asks: Ask[] = [];
  const run = (kind: Kind, get: (t: Track) => string) => {
    const by = new Map<string, Track[]>();
    for (const t of live) {
      const v = get(t);
      if (!v) continue;
      const list = by.get(v);
      if (list) list.push(t);
      else by.set(v, [t]);
    }
    for (const [from, ts] of by) {
      const first = ts[0]!;
      const r = cleanVietnamese(from);
      if (r) {
        fixes.push({ id: `${kind}:${from}`, kind, from, to: r.text, ids: ts.map((t) => t.id), reason: r.reason, on: true });
        continue;
      }
      const context = kind !== "artist" && (vnArtists.has(first.artist) || (kind === "title" && vnAlbums.has(first.album)));
      if (maybeNeedsAccents(from, context)) {
        asks.push({ id: `${kind}:${from}`, kind, from, ids: ts.map((t) => t.id), artist: kind === "artist" ? undefined : first.artist, album: kind === "title" ? first.album : undefined });
      }
    }
  };
  run("album", (t) => t.album);
  run("artist", (t) => t.artist);
  run("title", (t) => t.title);
  return { fixes, asks };
}

/**
 * Owner tool: cleans Vietnamese names. Typed marks and capitals are fixed by rules; names without accents are listed
 * and the owner picks which ones to send to the AI. Nothing is changed until the rows are applied.
 */
export function FixVietnamese({ tracks, refresh, onBack }: { tracks: Track[]; refresh: () => Promise<void>; onBack: () => void }) {
  const [rows, setRows] = useState<Fix[] | null>(null);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const stop = useRef(false);
  // Names that may be missing accents are only listed; the AI is asked about the ones you choose.
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(100);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // Two pages: the names to look at, and the changes to review (a separate page, so nothing is lost below a long list).
  const [view, setView] = useState<"names" | "review">("names");

  const patch = (id: string, p: Partial<Fix>) => setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...p } : r)));

  /** Rules first: instant, in the browser. */
  const doScan = async () => {
    const r = scan(tracks);
    // Names corrected before are used as they were corrected; names the owner said to leave alone are not offered.
    try {
      const known = new Map((await api.vietnameseCorrections()).corrections.map((c) => [c.from, c.to]));
      r.asks = r.asks.filter((a) => {
        const to = known.get(a.from);
        if (to === undefined) return true;
        if (to !== a.from) r.fixes.push({ id: a.id, kind: a.kind, from: a.from, to, ids: a.ids, reason: "learned", on: true });
        return false;
      });
    } catch {
      /* the scan still works without them */
    }
    setRows(r.fixes);
    setAsks(r.asks);
    setChosen(new Set());
    setFilter("");
    setShown(100);
    setMsg(
      r.fixes.length + r.asks.length === 0
        ? "Nothing to fix: every Vietnamese name already looks right."
        : r.fixes.length
          ? `${r.fixes.length} fix${r.fixes.length === 1 ? "" : "es"} found by rules.${r.asks.length ? " Pick names below to ask the AI about." : ""}`
          : "No rule-based fixes. Pick names below to ask the AI about.",
    );
  };

  /** Asks the AI about the given names, in batches, and adds the valid suggestions as rows to review. */
  const askAi = async (todo: Ask[]) => {
    stop.current = false;
    setBusy(true);
    setFresh(new Set());
    const fixed: Fix[] = [];
    const unchanged = new Set<string>();
    const answered = new Set<string>();
    try {
      for (let i = 0; i < todo.length && !stop.current; i += 25) {
        const batch = todo.slice(i, i + 25);
        setMsg(`Asking the AI… ${i} of ${todo.length} names`);
        const { results } = await api.restoreVietnamese(batch.map((a) => ({ key: a.id, text: a.from, kind: a.kind, artist: a.artist, album: a.album })));
        const answers = new Map(results.map((r) => [r.key, r.text]));
        const added: Fix[] = [];
        for (const a of batch) {
          answered.add(a.id);
          const to = answers.get(a.id);
          // Only a real Vietnamese answer counts: capitalising an English name is not a fix.
          if (to && hasVietnamese(to)) added.push({ id: a.id, kind: a.kind, from: a.from, to, ids: a.ids, reason: "accents", on: true });
          else unchanged.add(a.id);
        }
        fixed.push(...added);
        setRows((rs) => [...(rs ?? []).filter((r) => !added.some((x) => x.id === r.id)), ...added]);
      }
      const names = (ids: Iterable<string>) => [...ids].map((id) => todo.find((a) => a.id === id)!.from);
      const list = (xs: string[]) => xs.slice(0, 3).map((x) => `"${x}"`).join(", ") + (xs.length > 3 ? ` and ${xs.length - 3} more` : "");
      const noChange = names(unchanged);
      setMsg(
        (stop.current ? `Stopped after ${answered.size} of ${todo.length} names. ` : "") +
          (fixed.length
            ? `The AI suggested ${fixed.length} change${fixed.length === 1 ? "" : "s"}: ${list(fixed.map((f) => `${f.from} → ${f.to}`))}. Review them in the list below, untick or edit any that are wrong, then apply.`
            : "The AI did not suggest any change.") +
          (noChange.length ? ` Left as they are: ${list(noChange)} (not Vietnamese, or the AI was not sure).` : ""),
      );
      // Show what the AI suggested on the review page.
      setFresh(new Set(fixed.map((f) => f.id)));
      if (fixed.length) {
        setView("review");
        window.scrollTo(0, 0);
      }
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : "The AI request failed"} (${fixed.length} suggestions found before that).`);
    } finally {
      // A name with a suggestion moves to the review list; one the AI left alone stays here, marked, so nothing vanishes.
      const moved = new Set(fixed.map((f) => f.id));
      setAsks((as) => as.filter((a) => !moved.has(a.id)).map((a) => (unchanged.has(a.id) ? { ...a, note: "The AI found nothing to change" } : a)));
      setChosen(new Set());
      setBusy(false);
    }
  };

  const q = fold(filter);
  const matching = asks.filter((a) => !q || fold(a.from).includes(q) || fold(a.artist ?? "").includes(q));

  const picked = (rows ?? []).filter((r) => r.on && r.to.trim() !== "" && r.to.trim() !== r.from);

  const apply = async () => {
    setBusy(true);
    setMsg("");
    const failed: string[] = [];
    const notes = new Set<string>();
    const applied = new Set<string>();
    try {
      for (const kind of ["album", "artist"] as const) {
        for (const r of picked.filter((p) => p.kind === kind)) {
          setMsg(`Renaming ${kind}s… ${applied.size + 1} of ${picked.length}`);
          try {
            const res = await api.renameGroup(kind, r.from, r.to.trim());
            if (res.warning) notes.add(res.warning);
            applied.add(r.id);
          } catch (e) {
            failed.push(`${r.from}: ${e instanceof Error ? e.message : "failed"}`);
          }
        }
      }
      const titles = picked.filter((p) => p.kind === "title");
      const edits = titles.flatMap((r) => r.ids.map((id) => ({ id, title: r.to.trim(), row: r.id })));
      for (let i = 0; i < edits.length; i += 90) {
        const chunk = edits.slice(i, i + 90);
        setMsg(`Changing titles… ${i} of ${edits.length} songs`);
        try {
          const res = await api.editTitles(chunk.map(({ id, title }) => ({ id, title })));
          if (res.warning) notes.add(res.warning);
          chunk.forEach((c) => applied.add(c.row));
        } catch (e) {
          failed.push(`${chunk.length} titles: ${e instanceof Error ? e.message : "failed"}`);
        }
      }
      // Remember what was decided about AI and earlier-corrected names, for the whole family: the names as applied
      // (including your edits), and the ones you unticked, which are left alone from now on.
      const learn = [
        ...(rows ?? []).filter((r) => (r.reason === "accents" || r.reason === "learned") && applied.has(r.id)).map((r) => ({ from: r.from, to: r.to.trim() })),
        ...(rows ?? []).filter((r) => (r.reason === "accents" || r.reason === "learned") && !r.on).map((r) => ({ from: r.from, to: r.from })),
      ];
      if (learn.length > 0) {
        try {
          for (let i = 0; i < learn.length; i += 200) await api.saveVietnameseCorrections(learn.slice(i, i + 200));
        } catch {
          notes.add("The corrections could not be remembered for the AI.");
        }
      }
      await refresh();
      const stillOpen = new Set(failed.length ? picked.filter((p) => !applied.has(p.id)).map((p) => p.id) : []);
      setRows((rs) => (rs ?? []).filter((r) => !applied.has(r.id) || stillOpen.has(r.id)));
      setMsg(
        `Done: ${applied.size} name${applied.size === 1 ? "" : "s"} changed.` +
          (failed.length ? ` ${failed.length} failed: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "…" : ""}.` : "") +
          (notes.size ? ` ${[...notes].join(" ")}` : ""),
      );
    } finally {
      setBusy(false);
    }
  };

  const flipTo = (v: "names" | "review") => {
    setView(v);
    setFresh(new Set());
    window.scrollTo(0, 0);
  };

  if (view === "review") {
    return (
      <section className="fixv">
        <p><button className="link" onClick={() => flipTo("names")} disabled={busy}>← Back to names</button></p>
        <h2>Review changes <small>{(rows ?? []).length}</small></h2>
        <p className="muted">Nothing is saved until you press Apply. Edit any new name, or untick the ones that are wrong; what you decide is remembered for the AI.</p>
        {msg && <p className={/failed|could not|error/i.test(msg) ? "error" : "muted"} role="status">{busy && <span className="spinner" />}{msg}</p>}
        {(rows ?? []).length === 0 ? (
          <p className="muted">No changes to review. <button className="link" onClick={() => flipTo("names")}>Back to names</button></p>
        ) : (
          <>
            <p className="fixv-bar">
              <strong>{picked.length} selected</strong>
              <button className="link" onClick={() => setRows((rs) => (rs ?? []).map((r) => ({ ...r, on: true })))}>Select all</button>
              <button className="link" onClick={() => setRows((rs) => (rs ?? []).map((r) => ({ ...r, on: false })))}>Select none</button>
              <button className="primary" onClick={() => void apply()} disabled={busy || picked.length === 0}>Apply {picked.length} changes</button>
            </p>
            {KINDS.map(([kind, label]) => {
              const list = (rows ?? []).filter((r) => r.kind === kind);
              if (list.length === 0) return null;
              return (
                <div key={kind}>
                  <h4>{label} <small>{list.length}</small></h4>
                  <ul className="fixv-list">
                    {list.map((r) => (
                      <li key={r.id} className={`${r.on ? "picked" : ""}${fresh.has(r.id) ? " fresh" : ""}`}>
                        <input className="pick" type="checkbox" checked={r.on} disabled={busy} onChange={(e) => patch(r.id, { on: e.target.checked })} aria-label={`Change ${r.from}`} />
                        <div className="fixv-names">
                          <small className="muted">{r.from}{r.kind !== "album" && r.ids.length > 1 ? ` · ${r.ids.length} songs` : ""}{r.kind === "album" ? ` · ${r.ids.length} songs` : ""}</small>
                          <input type="text" value={r.to} disabled={busy} onChange={(e) => patch(r.id, { to: e.target.value })} aria-label={`New name for ${r.from}`} />
                        </div>
                        <small className="fixv-reason">{REASON[r.reason]}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </>
        )}
      </section>
    );
  }

  return (
    <section className="fixv">
      <p><button className="link" onClick={onBack} disabled={busy}>← Library tools</button></p>
      <h2>Fix Vietnamese names</h2>
      <p className="muted">
        Finds Vietnamese titles, albums and artists with missing accents or wrong capitals. You choose which names to ask the AI about,
        and review every change before it is saved.
      </p>
      <p>
        <button className="primary" onClick={() => void doScan()} disabled={busy}>{rows === null ? "Scan the library" : "Scan again"}</button>{" "}
        {busy && <button onClick={() => { stop.current = true; }}>Stop</button>}
      </p>
      {msg && <p className={/failed|could not|error/i.test(msg) ? "error" : "muted"} role="status">{busy && <span className="spinner" />}{msg}</p>}
      {rows !== null && rows.length > 0 && (
        <p className="status">
          <strong>{rows.length} change{rows.length === 1 ? "" : "s"} ready to review</strong>{" "}
          <button className="primary" onClick={() => flipTo("review")} disabled={busy}>Review changes →</button>
        </p>
      )}
      {asks.length > 0 && (
        <div className="fixv-asks">
          <h4>May be missing accents <small>{asks.length}</small></h4>
          <p className="muted">
            These look like Vietnamese written without accents, but some may be English. Tick the ones you want and ask the AI; it only
            changes names it is sure about.
          </p>
          <p className="fixv-bar">
            <input type="search" placeholder="Filter names or artists" aria-label="Filter names" value={filter} onChange={(e) => { setFilter(e.target.value); setShown(100); }} />
            <button className="link" disabled={busy} onClick={() => setChosen(new Set(matching.slice(0, shown).map((a) => a.id)))}>Tick shown</button>
            <button className="link" disabled={busy || chosen.size === 0} onClick={() => setChosen(new Set())}>Clear</button>
            <button className="primary" disabled={busy || chosen.size === 0} onClick={() => void askAi(asks.filter((a) => chosen.has(a.id)))}>
              Ask the AI about {chosen.size} {chosen.size === 1 ? "name" : "names"}
            </button>
          </p>
          <ul className="fixv-list">
            {matching.slice(0, shown).map((a) => (
              <li key={a.id} className={chosen.has(a.id) ? "picked" : ""}>
                <input
                  className="pick"
                  type="checkbox"
                  checked={chosen.has(a.id)}
                  disabled={busy}
                  aria-label={`Ask the AI about ${a.from}`}
                  onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })}
                />
                <div className="fixv-names">
                  <strong>{a.from}</strong>
                  <small className="muted">{[KIND_LABEL[a.kind], a.kind !== "artist" ? a.artist : "", a.ids.length > 1 ? `${a.ids.length} songs` : "", a.note ?? ""].filter(Boolean).join(" · ")}</small>
                </div>
              </li>
            ))}
          </ul>
          {matching.length > shown && <p><button className="link" onClick={() => setShown((n) => n + 100)}>Show {Math.min(100, matching.length - shown)} more of {matching.length - shown}</button></p>}
          {matching.length === 0 && <p className="muted">No name matches the filter.</p>}
        </div>
      )}
    </section>
  );
}
