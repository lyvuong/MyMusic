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
  /** Made by AI (shown with a badge). */
  ai: boolean;
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
  /** 'import' is the Organize button; 'enrich' is the nightly art/genre job; 'youtube' adds one video's audio. */
  kind: "import" | "enrich" | "youtube";
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
  /** For a YouTube run: the song's "Artist – Title" as confirmed when it was added. */
  label?: string | null;
}

/** What the home server read from a YouTube link, to be confirmed or edited before the audio is downloaded. */
export interface YoutubeInfo {
  title: string;
  artist: string;
  album: string;
  /** Seconds. */
  duration: number;
  thumbnail: string | null;
  /** Longer than the server accepts. */
  tooLong: boolean;
  /** YouTube itself labels the video "Made with AI" (altered or generated sounds or visuals). */
  aiLabel: boolean;
  /** The video's description or tags suggest AI-generated music (Suno, Udio, "AI generated"). */
  aiHint: boolean;
}

/** Whether the home server API (imports, enrich, writing names into files) can be reached. */
export interface ServerStatus {
  configured: boolean;
  ok: boolean;
  /** Why it is unavailable. */
  error: string;
  /** The job running on the server right now, if any. */
  busy: string | null;
  /** Every job running on the server (an import or enrich, and YouTube downloads), by run id. */
  jobs?: { kind: string; id: string }[];
  /** Files waiting in the inbox. */
  waiting?: number;
  /** The server imports what lands in the inbox by itself. */
  autoImport?: boolean;
}
