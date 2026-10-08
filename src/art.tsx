import { useEffect, useState, type CSSProperties } from "react";
import type { Track } from "../shared/types";
import { api } from "./api";

/** Resolves a token-bearing media URL for an id; null until ready or when there is none. */
export function useMediaUrl(kind: "art" | "artist-art", id: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (id) void api.mediaUrl(kind, id).then(setUrl);
  }, [kind, id]);
  return url;
}

/** A stable hue from a name, so covers without art still get their own colour. */
const hue = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

/** Cover art for a track or album; falls back to a colour block with a note when there is no image. */
export function Cover({ track, seed, className = "" }: { track?: Track | null; seed: string; className?: string }) {
  const url = useMediaUrl("art", track?.hasArt ? track.id : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={`cover ${className}`} style={{ "--h": hue(seed) } as CSSProperties}>
      <span className="cover-note">♪</span>
      {url && !failed && <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />}
    </div>
  );
}

/** Round artist picture; falls back to the artist's initial. */
export function ArtistPic({ name, className = "" }: { name: string; className?: string }) {
  const url = useMediaUrl("artist-art", name ? encodeURIComponent(name) : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={`cover round ${className}`} style={{ "--h": hue(name) } as CSSProperties}>
      <span className="cover-note">{name.trim().charAt(0).toUpperCase() || "♪"}</span>
      {url && !failed && <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />}
    </div>
  );
}
