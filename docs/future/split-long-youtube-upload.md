# Future enhancement: split a long YouTube upload into songs

Status: designed, not built. Low priority (rarely needed). A separate "Split" page in the web app that finds the breaks between songs in one long upload, lets the owner check each break by ear, then imports the pieces as one album.

## Goal
Take one long YouTube upload (a 1-hour mix or a full album), find where the songs change, let the owner check each break by ear, then import the pieces as ONE album.

## Findings that shape the design
Tested on a 1-hour upload titled "12 Ca Khúc":

- It has no chapters, no timestamps in the description, and only an auto-generated caption track. yt-dlp's JSON reports `chapters: None`, so the chapter and description-timestamp approach finds nothing.
- The "Explore this course" and "Course progress" panels on the watch page are only a playlist of other videos and the viewer's watch progress. They carry no track data.
- ffmpeg `silencedetect` works as a fallback:

  | Setting | Result |
  |---|---|
  | `-35dB`, 1 s | 3 gaps. Too strict; leaves a 38 minute lump |
  | `-26dB`, 0.25 s | 11 candidates at song-like intervals. Best first pass |
  | `-22dB`, 0.15 s | about 60. Too noisy alone, but useful inside a long segment |

  The first pass plus one dip from the loose pass inside the one 12.5 minute stretch gives exactly 12 tracks, matching the series name. This was not verified by ear.
- Songs that crossfade with no dip will not be found, and titles cannot be detected (tracks come in as "Track 1..N" until renamed).

## Boundary algorithm
A pure function, easy to unit test:

1. Take the silences from `silencedetect=noise=-26dB:d=0.25` (strict) and `noise=-22dB:d=0.15` (loose). A boundary is the midpoint of a silence.
2. Merge boundaries closer than a minimum track length (120 s), keeping the one with the longest silence. Drop any within 120 s of the start or end.
3. For any segment longer than about 8 minutes, add the longest loose-pass dip at least 120 s from both ends. Repeat on the pieces.
4. The user always reviews and edits the result.

## Home server (`scripts/unraid/mymusic-api`, standard library only, `docker exec yt-dlp ffmpeg ...`)
New `jobs/split.py` with in-memory sessions (at most 3, expiring after 3 hours). The folder `/downloads/_youtube/_split/<id>` is already cleaned at startup by `clear_leftovers` and ignored by the inbox watcher.

- `POST /split/start {url}` returns `{id}` at once. A thread runs `yt_info`, downloads `audio.mp3` and the thumbnail, runs the two silencedetect passes and stores the boundaries. It has its own duration cap (for example 4 hours) instead of `YT_MAX_SECONDS`.
- `GET /split/<id>` returns `{state: downloading|analyzing|ready|failed, message, title, artist, duration, aiLabel, boundaries: [seconds]}`.
- `GET /split/<id>/clip?start=&dur=` returns mp3 bytes (`ffmpeg -ss S -t D -i audio.mp3 -vn -c copy -f mp3 -`, `dur` at most 30 s). This needs a binary-response helper next to `Handler.send`.
- `POST /split/discard {id}` removes a session.
- Applying is not a new endpoint. The Worker queues a normal `youtube` run whose payload carries `split: {session, tracks: [{title, start, end}]}`. `http_handler` validates it on `/jobs` (2 to 100 tracks, numbers, `clean_tag` on titles, session id matches `RUN_ID_RE`), and `run_youtube` hands over to `run_split`, which:
  1. makes one square 600 px cover from the thumbnail;
  2. cuts each track from the session audio with `-ss/-t -c copy`, tags `title`, `artist`, `album_artist`, `album` and `track=N/M`, and attaches the cover, into `/downloads/_youtube/<run_id>/NN - Title.mp3`;
  3. imports under `beets_lock` as an album, `beet -p fromfilename import -A -q <folder>` (no `-s`), and reports "album probably already in the library" if mp3s remain;
  4. deletes the run folder and, on success, the session. On failure the session is kept so the owner can retry.
- Unit tests go in `tests/test_basics.py`: boundary picking (use the numbers above as a fixture), payload validation and filename sanitising.

## Worker (`worker/`)
All routes are owner-only (the `youtubeOwner` guard), with the id validated against `/^[A-Za-z0-9_-]{1,64}$/`.

- Routes: `POST /api/split/start`, `GET /api/split/:id`, `GET /api/split/:id/clip?start&dur` (proxies the bytes as `audio/mpeg`), `POST /api/split/:id/apply`, `DELETE /api/split/:id`.
- `home.ts`: a raw/bytes variant of `call()`. `homeStartJob`'s `extra` must allow non-string values (the `split` object).
- `beets.ts`: `YoutubePayload` gains an optional `split`, and `parsePayload` must keep it.
- `ytqueue.ts`: forward `split`, and skip `coverFor` for split runs (the video thumbnail is used).
- `apply`: `enqueueYoutube` with `url` set to the video link (this also de-duplicates the same link), `title` and `album` set to the album name, `artist` set to the album artist. If the AI box is ticked, insert one `pending_ai` row per track title (as a batch).

## Web app (`src/`)
- A new owner-only "Split" tab (add it to `Tab` and `tabs` in `App.tsx`), implemented in a new `src/Split.tsx`. Pure helpers go in `src/splitLogic.ts` (break list to tracks, mm:ss parsing and formatting) with vitest tests next to `search.test.ts`.
- Flow: paste the link, Analyze (polls status every 2 s), review, Create album.
- Review UI:
  - a timeline bar with break markers;
  - a list of breaks, each with **Play break** (a clip from t-5 s to t+5 s with a centre tick, window selectable 3/5/10 s), nudge buttons (-5 s, -1 s, +1 s, +5 s, replaying after each nudge), remove, and "add break at mm:ss";
  - a list of tracks (start to end, editable title, default "Track N");
  - album name (default: the video title), album artist (default: the channel) and an AI checkbox.
- Clips are fetched with the Bearer token and played from a blob URL in the page's own `<audio>`. Pause the main player first (`usePlayer()` in `player.tsx`).
- After "Create album", tell the owner it is queued and offer a button to the Family tab, where `Organize`'s `track()` loop follows the run and syncs the library when it finishes.

## Docs and checks
- README: a new section next to the YouTube import one, and the new endpoints in the `server.py` docstring.
- Verify with `python -m unittest discover` (mymusic-api tests), `npm run typecheck` and `npm test`. Then run one real long video end to end on the server and check the album, track order, covers and the break previews by ear.
- The home-server image and the Worker deploy independently. Ship the Python image first, and have the Worker report a clear error if the home server does not know `/split/*` yet.
