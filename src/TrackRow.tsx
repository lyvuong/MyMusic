import type { Track } from "../shared/types";
import { AiBadge, Cover } from "./art";
import { usePlayer } from "./player";
import { Stars } from "./ratings";

/** One song in a list: play button with cover, names, rating stars and whatever the list adds (`extra`). */
export function TrackRow({ t, queue, extra, number, hideArtist, select, note }: { t: Track; queue: Track[]; extra?: React.ReactNode; number?: number; hideArtist?: boolean; select?: { picked: boolean; toggle: () => void }; note?: string }) {
  const p = usePlayer();
  const active = p.current?.id === t.id;
  const mins = Math.floor(t.duration / 60);
  return (
    <li className={`row${active ? " active" : ""}${select?.picked ? " picked" : ""}`} onClick={select?.toggle}>
      {select && <input className="pick" type="checkbox" checked={select.picked} onChange={select.toggle} onClick={(e) => e.stopPropagation()} aria-label={`Select ${t.title}`} />}
      <button className="lead" onClick={select ? undefined : () => p.play(queue, queue.findIndex((x) => x.id === t.id))} aria-label={`Play ${t.title}`}>
        {number === undefined ? <Cover track={t} seed={t.album || t.title} className="sm" /> : <span className="num">{number || "–"}</span>}
        <span className="badge">{active && p.playing ? "♪" : "▶"}</span>
      </button>
      <span className="grow">
        <strong>{t.title}{t.ai && <> <AiBadge /></>}</strong>
        <small>{[hideArtist ? "" : t.artist, number === undefined ? t.album : ""].filter(Boolean).join(" · ")}</small>
        {note && <small className="muted">{note}</small>}
      </span>
      {t.duration > 0 && <small className="dur">{mins}:{String(Math.floor(t.duration % 60)).padStart(2, "0")}</small>}
      {!select && <Stars trackId={t.id} title={t.title} />}
      {extra}
    </li>
  );
}
