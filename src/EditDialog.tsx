import { useEffect, useId, useRef, useState } from "react";

export interface EditField {
  key: string;
  label: string;
  value: string;
  /** Existing names offered while typing (a datalist); free text is still allowed. */
  options?: string[];
  numeric?: boolean;
  /** Empty is rejected for this field. */
  required?: boolean;
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
  const uid = useId();
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

  const submit = async () => {
    if (missing || unchanged || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(values);
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
        {fields.map((f, i) => (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            <input
              ref={i === 0 ? first : undefined}
              type={f.numeric ? "number" : "text"}
              min={f.numeric ? 0 : undefined}
              lang="vi"
              autoComplete="off"
              value={values[f.key]}
              list={f.options ? `${uid}-${f.key}` : undefined}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {f.options && <datalist id={`${uid}-${f.key}`}>{f.options.map((o) => <option key={o} value={o} />)}</datalist>}
          </label>
        ))}
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
