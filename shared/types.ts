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
  ownerUid: string;
  shared: boolean;
  trackIds: string[];
  updatedAt: number;
  deleted: boolean;
}

export interface FamilyInfo {
  id: string;
  name: string;
  role: "owner" | "member";
  members: { uid: string; displayName: string; email: string; role: "owner" | "member" }[];
}
