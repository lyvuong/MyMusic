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
  /** From the file's tags (NAS songs) or set for the artist; empty when unknown. */
  genre: string;
  /** The artist's genre as the app worked it out, only when `genre` is empty: shown marked as a guess. */
  genreGuess?: string;
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

/** A member's top three artists and songs, from their own ratings, plays and skips (rebuilt with the nightly mixes). */
export interface TasteProfile {
  uid: string;
  artists: { name: string; songs: number }[];
  tracks: { id: string; title: string; artist: string }[];
  builtAt: number;
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
/** A song in a group of duplicates. */
export interface DupSong {
  id: string; source: "r2" | "nas"; title: string; artist: string; album: string;
  duration: number; trackNo: number; size: number;
  /** How many playlists hold it, its best rating (0 = unrated) and how often it was played. */
  lists: number; rating: number; plays: number;
}
/** Copies of one song, with the id of the one suggested to keep. */
export interface DupGroup { songs: DupSong[]; keep: string }

export interface YoutubePlaylist {
  title: string;
  items: { url: string; title: string; duration: number }[];
  /** Private or deleted videos left out. */
  skipped: number;
}

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

/**
 * One mix, as the home page shows it (the songs are in HomeData.tracks). `daypart` is "morning" | "afternoon" |
 * "evening" | "night" for the AI mixes, or a key like "theme-vietnamese" for a themed hour of music.
 */
export interface MixInfo {
  daypart: string;
  /** The song whose cover stands for the mix. */
  cover?: string;
  title: string;
  intro: string;
  generatedAt: number;
  trackIds: string[];
}

/** Everything the start page needs, in one small request: the library itself is never sent. */
export interface HomeData {
  mixes: MixInfo[];
  /** The newest songs, newest first (the page groups them into albums). */
  recent: Track[];
  lists: { popular: string[]; top: string[]; rediscover: string[] };
  /** The songs that mixes and lists refer to. */
  tracks: Track[];
  /** `guessed`: the artist's genre was worked out by the app, not read from the songs. */
  genres: { name: string; count: number; guessed?: boolean }[];
  /** Songs with no genre, not even a guessed one. */
  untagged: number;
  songs: number;
  /** Uploaded songs whose cover was never looked up. */
  missingCovers: number;
}

/** A page of songs from search or browsing; `next` is what to send as `cursor` for the following page. */
export interface BrowsePage {
  tracks: Track[];
  next: number | null;
}
