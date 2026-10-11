import { useState } from "react";
import type { Track } from "../shared/types";
import { cleanVietnamese, hasVietnamese, maybeNeedsAccents } from "../shared/vietnamese";
import { api } from "./api";

type Kind = "album" | "artist" | "title";

interface Fix {
  id: string;
  kind: Kind;
  from: string;
  to: string;
  /** The songs that carry this name (a title is applied to each of them). */
  ids: string[];
  reason: "typed" | "case" | "accents";
  on: boolean;
}

interface Ask { id: string; kind: Kind; from: string; ids: string[]; artist?: string; album?: string }

const KINDS: [Kind, string][] = [["album", "Albums"], ["artist", "Artists"], ["title", "Titles"]];
const REASON: Record<Fix["reason"], string> = { typed: "typed marks", case: "capitals / spacing", accents: "AI: accents" };

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
 * Owner tool: cleans Vietnamese names. Typed marks and capitals are fixed by rules; names without accents are sent to
 * the AI in batches. Nothing is changed until the owner ticks the rows and applies them.
 */
export function FixVietnamese({ tracks, refresh }: { tracks: Track[]; refresh: () => Promise<void> }) {
  const [rows, setRows] = useState<Fix[] | null>(null);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const doScan = () => {
    const r = scan(tracks);
    setRows(r.fixes);
    setAsks(r.asks);
    setMsg(r.fixes.length + r.asks.length === 0 ? "Nothing to fix: every Vietnamese name already looks right." : "");
  };

  const patch = (id: string, p: Partial<Fix>) => setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...p } : r)));

  const askAi = async () => {
    const todo = asks;
    setBusy(true);
    setMsg("");
    let found = 0;
    try {
      for (let i = 0; i < todo.length; i += 25) {
        const batch = todo.slice(i, i + 25);
        setMsg(`Asking the AI… ${i} of ${todo.length} names`);
        const { results } = await api.restoreVietnamese(batch.map((a) => ({ key: a.id, text: a.from, artist: a.artist, album: a.album })));
        const answers = new Map(results.map((r) => [r.key, r.text]));
        const added: Fix[] = [];
        for (const a of batch) {
          const to = answers.get(a.id);
          if (to) added.push({ id: a.id, kind: a.kind, from: a.from, to, ids: a.ids, reason: "accents", on: false });
        }
        found += added.length;
        setRows((rs) => [...(rs ?? []), ...added]);
      }
      setAsks([]);
      setMsg(`The AI suggested accents for ${found} of ${todo.length} names. Review them below, then tick the ones that are right.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "The AI request failed");
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <section className="fixv">
      <h3>Fix Vietnamese names</h3>
      <p className="muted">
        Finds names typed in ASCII (<code>Hu+o+ng Ca^`n</code>), written without accents (<code>Con Yeu Em Mai</code>) or with wrong capitals,
        for titles, albums and artists. You review every change before it is applied; it also rewrites the file tags.
      </p>
      <p>
        <button onClick={doScan} disabled={busy}>{rows === null ? "Scan the library" : "Scan again"}</button>{" "}
        {asks.length > 0 && (
          <button className="primary" onClick={() => void askAi()} disabled={busy}>Ask the AI about {asks.length} names without accents</button>
        )}
      </p>
      {msg && <p className={/failed|could not|error/i.test(msg) ? "error" : "muted"}>{busy && <span className="spinner" />}{msg}</p>}
      {rows !== null && rows.length > 0 && (
        <>
          <p className="fixv-bar">
            <strong>{picked.length} selected</strong>
            <button className="link" onClick={() => setRows((rs) => (rs ?? []).map((r) => ({ ...r, on: true })))}>Select all</button>
            <button className="link" onClick={() => setRows((rs) => (rs ?? []).map((r) => ({ ...r, on: false })))}>Select none</button>
            <button className="primary" onClick={() => void apply()} disabled={busy || picked.length === 0}>Apply {picked.length} changes</button>
          </p>
          {KINDS.map(([kind, label]) => {
            const list = rows.filter((r) => r.kind === kind);
            if (list.length === 0) return null;
            return (
              <div key={kind}>
                <h4>{label} <small>{list.length}</small></h4>
                <ul className="fixv-list">
                  {list.map((r) => (
                    <li key={r.id} className={r.on ? "picked" : ""}>
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
