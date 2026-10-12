import { useEffect, useRef, useState } from "react";
import { hasVietnamese } from "../shared/vietnamese";
import { api } from "./api";

export interface EditField {
  key: string;
  label: string;
  value: string;
  /** Existing names matched against what is typed (a partial name is enough); free text is still allowed. */
  options?: string[];
  numeric?: boolean;
  /** Empty is rejected for this field. */
  required?: boolean;
  /** A tick box: the value is "1" when ticked, "" when not. */
  checkbox?: boolean;
  /** Shows "Add accents": asks the AI to restore Vietnamese accents on this one name. */
  accents?: boolean;
}

/** Lowercase, no diacritics (đ -> d), words separated by single spaces: "Hương  Cần" and "huong can" compare equal. */
export const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Existing names that match a partial entry, best first: starts with it, has every typed word start, contains it,
 * or is a shorter form of it. The value being edited and an exact match are left out (the hint covers a match). */
export function suggest(options: string[], value: string, limit = 6): string[] {
  const q = fold(value);
  if (!q) return [];
  const words = q.split(" ");
  const scored: { o: string; score: number }[] = [];
  for (const o of options) {
    if (o === value || o.trim() === value.trim()) continue;
    const f = fold(o);
    if (!f) continue;
    const fw = f.split(" ");
    const score = f.startsWith(q) ? 1
      : words.every((w) => fw.some((x) => x.startsWith(w))) ? 2
      : f.includes(q) ? 3
      : f.length >= 3 && q.includes(f) ? 4
      : 0;
    if (score) scored.push({ o, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.o.length - b.o.length || a.o.localeCompare(b.o)).slice(0, limit).map((x) => x.o);
}

interface Props {
  title: string;
  fields: EditField[];
  /** Explains what saving will do, from the current values (e.g. "merges into an existing album"). */
  hint?: (values: Record<string, string>) => { text: string; action?: string } | null;
  onSave: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
}

/** A small modal form for editing names. Text is sent as typed, so Vietnamese input works as in any text box. */
export function EditDialog({ title, fields, hint, onSave, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState("");
  // What the AI was asked about per field, so the final text can be remembered as the correction.
  const asked = useRef<Record<string, string>>({});
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    first.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const h = hint?.(values) ?? null;
  const missing = fields.some((f) => f.required && !values[f.key]!.trim());
  const unchanged = fields.every((f) => values[f.key]!.trim() === f.value.trim());

  /** One name to the AI. The artist and album fields (if the dialog has them) are sent as context. */
  const addAccents = async (key: string) => {
    setAsking(key);
    setAiNote("");
    setError("");
    try {
      const { results } = await api.restoreVietnamese([{ key, text: values[key]!.trim(), artist: values.artist?.trim() || undefined, album: values.album?.trim() || undefined }]);
      asked.current[key] = values[key]!.trim();
      const text = results[0]?.text;
      if (text && hasVietnamese(text)) setValues((v) => ({ ...v, [key]: text }));
      else setAiNote("The AI did not find accents to add. It may not be Vietnamese.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The AI request failed");
    } finally {
      setAsking(null);
    }
  };

  const submit = async () => {
    if (missing || unchanged || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(values);
      // Teach the AI: the name as saved (your edit, or its answer, or the original if you refused it).
      const learn = Object.entries(asked.current).map(([key, from]) => ({ from, to: (values[key] ?? "").trim() })).filter((p) => p.from && p.to);
      if (learn.length > 0) void api.saveVietnameseCorrections(learn).catch(() => undefined);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal card" role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h3>{title}</h3>
        {fields.map((f, i) => f.checkbox ? (
          <label key={f.key} className="field check">
            <input type="checkbox" checked={values[f.key] === "1"} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked ? "1" : "" }))} />
            <span>{f.label}</span>
          </label>
        ) : (
          <label key={f.key} className="field">
            <span>
              {f.label}
              {f.accents && values[f.key]!.trim() !== "" && !hasVietnamese(values[f.key]!) && (
                <> · <button type="button" className="link" disabled={asking !== null || busy} onClick={() => void addAccents(f.key)}>{asking === f.key ? "Asking the AI…" : "Add accents with AI"}</button></>
              )}
            </span>
            <input
              ref={i === 0 ? first : undefined}
              type={f.numeric ? "number" : "text"}
              min={f.numeric ? 0 : undefined}
              lang="vi"
              autoComplete="off"
              value={values[f.key]}
              onFocus={() => setFocus(f.key)}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {f.options && focus === f.key && (() => {
              // Before anything is typed, offer names similar to the current one (same words without accents or case).
              const typed = values[f.key]!;
              const list = suggest(f.options, typed).filter((o) => o !== f.value);
              return list.length > 0 && (
                <span className="suggest" role="listbox" aria-label={`Matching ${f.label.toLowerCase()}s`}>
                  {list.map((o) => (
                    <button
                      key={o}
                      type="button"
                      role="option"
                      aria-selected={false}
                      // mousedown, so the pick lands before the input loses focus
                      onMouseDown={(e) => { e.preventDefault(); setValues((v) => ({ ...v, [f.key]: o })); }}
                    >{o}</button>
                  ))}
                </span>
              );
            })()}
          </label>
        ))}
        {aiNote && <p className="muted hint" role="status">{aiNote}</p>}
        {h && <p className="muted hint">{h.text}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || missing || unchanged}>{busy ? "Saving…" : (h?.action ?? "Save")}</button>
        </div>
      </form>
    </div>
  );
}
