export interface Track {
  id: string;
  source: "r2" | "nas";
  title: string;
  artist: string;
  album: string;
  duration: number;
  trackNo: number;
  hasArt: boolean;
  size: number;
  etag: string;
  mime: string;
  updatedAt: number;
  deleted: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  updatedAt: number;
  deleted: boolean;
}
