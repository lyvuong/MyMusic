/** The genres the AI may answer with (and the editor suggests); the themes in themes.ts match on these words. */
export const GENRES = [
  "Pop", "Rock", "Hip-Hop", "R&B", "Soul", "Dance", "Electronic", "Ballad", "Jazz", "Blues", "Classical", "Instrumental",
  "Folk", "Country", "Acoustic", "Latin", "K-Pop", "Metal", "Reggae", "Soundtrack",
  "Vietnamese Pop", "Vietnamese Ballad", "Vietnamese Bolero", "Vietnamese Rap",
];

/** The genre filter's value for "songs with no genre at all"; "~Pop" asks for songs guessed as Pop, "Pop" for real ones. */
export const UNTAGGED = "~";

/** The filter value for one entry of the genre list. */
export const genreValue = (g: { name: string; guessed?: boolean }) => (g.guessed ? UNTAGGED : "") + g.name;
