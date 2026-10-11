import type { ReactNode } from "react";
import type { Track } from "../shared/types";
import { AiBadge, ArtistPic, Cover } from "./art";
import { usePlayer } from "./player";

export interface Album {
  key: string;
  name: string;
  artist: string;
  tracks: Track[];
  art?: Track;
  updatedAt: number;
}

export interface Artist {
  name: string;
  tracks: Track[];
}

const byTrackNo = (a: Track, b: Track) => a.trackNo - b.trackNo || a.title.localeCompare(b.title);

/** Albums are the distinct album names (like the phone app); songs without an album tag are left out. */
export function groupAlbums(tracks: Track[]): Album[] {
  const m = new Map<string, Track[]>();
  for (const t of tracks) if (t.album) (m.get(t.album) ?? m.set(t.album, []).get(t.album)!).push(t);
  return [...m].map(([name, list]) => {
    const sorted = list.sort(byTrackNo);
    const artists = new Set(sorted.map((t) => t.artist).filter(Boolean));
    return {
      key: name,
      name,
      artist: artists.size === 1 ? [...artists][0]! : artists.size > 1 ? "Various artists" : "",
      tracks: sorted,
      art: sorted.find((t) => t.hasArt),
      updatedAt: Math.max(...sorted.map((t) => t.updatedAt)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function groupArtists(tracks: Track[]): Artist[] {
  const m = new Map<string, Track[]>();
  for (const t of tracks) if (t.artist) (m.get(t.artist) ?? m.set(t.artist, []).get(t.artist)!).push(t);
  return [...m]
    .map(([name, list]) => ({ name, tracks: list.sort((a, b) => a.album.localeCompare(b.album) || byTrackNo(a, b)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const songCount = (n: number) => `${n} song${n === 1 ? "" : "s"}`;

function totalLength(tracks: Track[]) {
  const mins = Math.round(tracks.reduce((s, t) => s + t.duration, 0) / 60);
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

export function AlbumCard({ album, onOpen }: { album: Album; onOpen: () => void }) {
  return (
    <button className="tile" onClick={onOpen}>
      <Cover track={album.art} seed={album.name} />
      <strong>{album.name}{album.tracks.every((t) => t.ai) && <> <AiBadge /></>}</strong>
      <small>{album.artist || songCount(album.tracks.length)}</small>
    </button>
  );
}

export function ArtistCard({ artist, onOpen }: { artist: Artist; onOpen: () => void }) {
  return (
    <button className="tile artist-tile" onClick={onOpen}>
      <ArtistPic name={artist.name} />
      <strong>{artist.name}</strong>
      <small>{songCount(artist.tracks.length)}</small>
    </button>
  );
}

/** Page header for an album or artist: big picture, title, Play and Shuffle. */
export function Hero({ cover, title, subtitle, tracks, onBack, actions }: { cover: ReactNode; title: string; subtitle: string; tracks: Track[]; onBack: () => void; actions?: ReactNode }) {
  const p = usePlayer();
  const shuffled = () => {
    const a = [...tracks];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  return (
    <div className="hero">
      <button className="link" onClick={onBack}>← Back</button>
      <div className="hero-body">
        {cover}
        <div className="hero-text">
          <h2>{title}</h2>
          <p className="muted">{[subtitle, songCount(tracks.length), totalLength(tracks)].filter(Boolean).join(" · ")}</p>
          <div className="hero-actions">
            <button className="primary" onClick={() => p.play(tracks, 0)}>▶ Play</button>
            <button onClick={() => p.play(shuffled(), 0)}>⤮ Shuffle</button>
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
}
