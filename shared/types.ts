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

/** An AI listening suggestion built from the caller's ratings. */
export interface Suggestion {
  title: string;
  intro: string;
  /** Songs from the library, in listening order, each with a short reason. */
  tracks: { id: string; why: string }[];
  /** Artists or albums that are not in the library. */
  discover: { artist: string; album: string; why: string }[];
}

/** One Beets import on the home server, requested from the web app. */
export interface BeetsRun {
  id: string;
  /** 'import' is the Organize button; 'enrich' is the nightly art/genre job. */
  kind: "import" | "enrich";
  status: "requested" | "running" | "done" | "failed";
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Files waiting in the inbox before and after the run. */
  inboxBefore: number | null;
  inboxAfter: number | null;
  /** Files still in the inbox right now, reported while the run is going. */
  inboxNow: number | null;
  exitCode: number | null;
  /** The end of the import output. */
  log: string;
}
