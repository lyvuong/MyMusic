# MyMusic

[![CI](https://github.com/lyvuong/MyMusic/actions/workflows/ci.yml/badge.svg)](https://github.com/lyvuong/MyMusic/actions/workflows/ci.yml)
![Platform: Android](https://img.shields.io/badge/platform-Android-3DDC84?logo=android&logoColor=white)
![Flutter](https://img.shields.io/badge/Flutter-02569B?logo=flutter&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Navidrome](https://img.shields.io/badge/Navidrome-NAS-0084ff)

A family music app: Android app (with Android Auto and offline downloads), a web player, and a Cloudflare Worker backend that sits in front of a Navidrome server on a home NAS.

What it does:
- Play the family library on the phone and the web, with playlists (private or shared), offline downloads and Android Auto.
- Rate songs 1-5 stars and get AI suggestions (a playlist from your library plus artists to discover, optionally for a mood).
- Edit song, album and artist names (including merging albums and artists); the new names are written into the files on the home server.
- Organize the music inbox with Beets from the web app, and run the cover/genre enrich on demand.

Parts:
- `worker/`: Hono Worker. Firebase sign-in, families (D1), library, playlists, ratings, AI suggestions, library sync and Range streaming from Navidrome (through a Cloudflare Tunnel), name editing and Beets runs (through the home server API), app releases.
- `src/`: web player (React + Vite PWA), served by the Worker as static assets.
- `flutter/`: Android app (`audio_service` + `just_audio`, Android Auto browse tree, offline downloads, ratings, For you).
- `scripts/unraid/`: everything that runs on the home server (see "Home server").
- `migrations/`: D1 schema, applied by CI on every push to `main`.
- `.github/workflows/ci.yml`: checks on every push; on `main` it applies migrations, deploys the Worker and publishes a signed APK.

## One-time setup

1. **Firebase**: create a project, enable Authentication, Google. Add a Web app (copy its config) and an Android app (`org.lv5.mymusic`, with your SHA-1 and SHA-256). Download `google-services.json` to `flutter/android/app/` (git-ignored). Add your Worker domain under Authorized domains. Copy the "Web client ID" from the Google provider.
2. **Cloudflare**:
   ```bash
   npx wrangler d1 create mymusic                 # put the database_id in wrangler.jsonc
   npx wrangler r2 bucket create mymusic-files
   npx wrangler r2 bucket create mymusic-releases
   ```
   Set `FIREBASE_PROJECT_ID` in `wrangler.jsonc`.
3. **Android signing key** (keep it safe; every future update must use it):
   ```bash
   keytool -genkeypair -v -keystore mymusic.jks -alias mymusic -keyalg RSA -keysize 2048 -validity 10000
   ```
4. **GitHub repository settings**
   - Variables: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`.
   - Secrets: `CLOUDFLARE_API_TOKEN` (Workers, D1, R2 edit), `CLOUDFLARE_ACCOUNT_ID`, `ANDROID_KEYSTORE_BASE64` (`base64 -w0 mymusic.jks`), `ANDROID_KEYSTORE_PASSWORD`, `GOOGLE_SERVICES_JSON_BASE64`.
5. Edit `flutter/config/production.json` with your Worker URL and Google web client ID.
6. Connect the home server: see "Home server" below (Navidrome, then the `mymusic-api` container).

## Worker configuration

| Name | Kind | Purpose |
|---|---|---|
| `FIREBASE_PROJECT_ID` | var | Verifies Firebase ID tokens |
| `NAS_BASE_URL` | var | Navidrome through its tunnel hostname; empty disables the NAS |
| `NAS_USER`, `NAS_PASSWORD` | secrets | Navidrome login; the user must be an **admin** (the app starts library scans) |
| `NAS_CF_ACCESS_ID`, `NAS_CF_ACCESS_SECRET` | secrets | Cloudflare Access service token, sent to Navidrome and to the home server API |
| `HOME_API_URL` | var | The `mymusic-api` tunnel hostname (`https://mymusic-api.lv5.uk`); empty disables Organize, enrich and name editing |
| `BEETS_AGENT_KEY` | secret | Shared key between the Worker and the home server (both directions) |
| `AI` | binding | Workers AI for suggestions (free daily allowance, no key) |
| `DB`, `MUSIC`, `RELEASES` | bindings | D1 database and the two R2 buckets |

## Home server (Unraid: Navidrome, File Browser, Beets, mymusic-api)

Host `Lincoln-Unraid`. Music lives in the share `/mnt/user/Music`. The Worker talks to two things there, both through Cloudflare Tunnels: Navidrome (Subsonic API, `NAS_*`) and the `mymusic-api` container (`HOME_API_URL`). Never put passwords or tokens in this file.

Flow: drop files in `/mnt/user/Music/_inbox` (File Browser or the SMB share) -> `mymusic-api` notices them (inotify, no polling; or press **Organize** in the web app) -> Beets organizes them into `/mnt/user/Music/Artist/Album/` -> enrich runs once the inbox has gone quiet -> the web app (when open) scans Navidrome and syncs the library.

### Compose stack
One `compose.yaml` runs five containers: `navidrome`, `filebrowser`, `beets`, `yt-dlp` and `mymusic-api` (all `restart: unless-stopped`; `:latest` images; `mymusic-api` is `ghcr.io/lyvuong/mymusic-api:latest`, built by CI from `scripts/unraid/mymusic-api/`). Beets runs as root (`PUID=0`, `PGID=0`, `TZ=America/New_York`) like File Browser, so it can write to files File Browser uploaded.

### Beets (container `beets`, image `lscr.io/linuxserver/beets:latest`)
- Mounts: `/mnt/user/appdata/beets` -> `/config`, `/mnt/user/Music` -> `/music`, `/mnt/user/Music/_inbox` -> `/downloads`.
- Config: `/mnt/user/appdata/beets/config.yaml` (library `/config/musiclibrary.blb`, log `/config/beet.log`). Library directory `/music`. A running `beet` reads the config only at start; restart the container after editing it.
- Plugins: `musicbrainz fetchart embedart scrub lastgenre` (plus `fromfilename`, used by the Organize import). Paths: `$albumartist/$album%aunique{}/$track - $title`; singles go to `Non-Album/%if{$artist,$artist - }$title` (only for `-s` singleton imports); compilations to `Compilations/...`.
- Import settings: `copy: no`, `move: yes` (files LEAVE `_inbox` once imported), `quiet_fallback: asis`, `resume: no`, `incremental: no`, `strong_rec_thresh: 0.15`. `asis` is needed: with `skip`, quiet mode silently skipped everything beets could not match. The skip reasons are written to `/config/skipped.log` (`-l`).
- Two-run setup (fast import, nightly enrich):
  - **Import** (the Organize button, or by itself when files arrive; run by `mymusic-api`): the files waiting are first moved into `_inbox/_staging/<run id>` (a rename, so files copied in meanwhile are not touched), then `beet -p musicbrainz,scrub,fromfilename import -g -q -l <log> /downloads/_staging/<run id>`, then `-s -q` for leftovers. `-p` overrides `plugins:`, so `fetchart`, `embedart` and `lastgenre` do not run and the import stays fast. Pass 1 groups files into albums by their tags; pass 2 imports what is left one by one, because untagged files all share a blank artist and album and would otherwise be skipped as "already in the library". Afterwards, files Beets skipped as duplicates are **deleted** when they are confirmed to be the same song as one in the library (same title and artist, from the tags or an `Artist - Title` file name, and a length within 3 seconds); a skipped file with a different length (remix, live version) or no names to compare is kept. Whatever is still left is moved to `_inbox/_skipped/<run id>`, so it never triggers the same run again; delete that folder when you have looked at it. The run's log lists what was removed and what was kept, and the history shows "N files, M not imported".
  - **Enrich** adds what the import skipped, for albums already in the library: first `fix-vietnamese.py --apply` (decodes ASCII-typed Vietnamese and capitalises every word of Vietnamese titles, albums and artists; the file must be at `/mnt/user/appdata/beets/fix-vietnamese.py`, and it is skipped with a log line if missing), then `beet fetchart`, `beet embedart -y 'added:-14d..'` (writes the cover into recent files only) and `beet lastgenre`, with the full plugin list. It runs nightly from `scripts/unraid/beets-enrich.sh` (a User Scripts job, custom cron `0 3 * * *`, log `/mnt/user/appdata/beets/enrich.log`) and on demand from **Run enrich now** in the web app. It reports each run to the Worker (`/api/beets/agent/enrich-start` and `/report`, with the same key file as `mymusic-api`), so the Family tab's "Beets history" lists it with its log. Paste an updated `beets-enrich.sh` into User Scripts after changing it.
  - Both share `/tmp/beets-import.lock`, so they never overlap. Check what is running with `docker exec beets pgrep -a beet` (the `beet web` line is only the Beets browser UI and is not needed).
- Matching notes: beets matches on existing tags/filenames via MusicBrainz (about 1 request/s, so big batches are slow). Files with junk tags (`05. Track 5.mp3`), loose single tracks, and many Vietnamese songs (diacritics stripped, weak coverage) do not match and are imported as-is under whatever tags they carry (empty tags end up under an `Unknown Artist`/empty-album folder, not `Non-Album/`). Find them with `docker exec beets beet ls -f '$artist | $album | $title | $path'` and queries like `albumartist::^$` or `album::^$`. Fix them by renaming in the web app, in Mp3tag, or with `beet modify`; `beet import -L [query]` re-matches albums already in the library, then run `beet update` and `beet move`.
- Chroma (audio fingerprinting): the `chroma` plugin identifies songs with junk tags/filenames via Chromaprint + AcoustID. The image already has `/usr/bin/fpcalc` and `pyacoustid`. Setup: add `chroma` to `plugins:`, add `chroma:` with `auto: yes`, then `docker restart beets` and confirm with `docker exec beets beet version`. It adds one lookup per file (slower imports) and cannot help for recordings MusicBrainz/AcoustID do not know (many Vietnamese songs).
- Album art: `fetchart: auto: yes, minwidth: 500` (smaller covers are rejected); `embedart: auto: yes`; cover file name `cover` (`art_filename`). For a one-off run on existing albums: `docker exec beets beet fetchart` (add `-f` to replace existing covers, or a query like `albumartist:"Paul Simon"`), then `beet embedart`. Albums that match nothing get no cover; the web player's "Find missing covers online" button (iTunes search) fills those in.

### mymusic-api (container `mymusic-api`): what the web app asks the server to do
A small Python service (`scripts/unraid/mymusic-api/`, entry point `server.py`, standard library only) that runs `docker exec beets ...` for the web app. The Worker calls it through a Cloudflare Tunnel, like it calls Navidrome, protected by the Cloudflare Access service token plus the shared key (`BEETS_AGENT_KEY`, header `X-Agent-Key`). Nothing polls: the Worker is told by the server, and the server learns about new files from inotify. The endpoints are fixed and no command or path comes from a request:

| Endpoint | What it does |
|---|---|
| `GET /health` | Checks the `beets` container answers; also lists the running jobs, the number of files waiting, whether auto import is on and the image version |
| `POST /edit` | Writes edited names into the files and the Beets library, and waits for the result |
| `POST /cover` | Writes an album's cover image as `cover.jpg` into the folders of its songs (what Navidrome looks for first) and records it in the Beets library |
| `POST /yt-info` | Reads a YouTube link's title, artist and length with yt-dlp, without downloading it |
| `POST /jobs` | Starts an `import`, an `enrich` or a `youtube` download and returns at once; progress and result are posted back to the Worker (`/api/beets/agent/progress` and `/report`) under the run id |

There is **no fallback**: if the server cannot be reached, the app disables Organize, enrich and name editing and shows the reason (checked on load, every minute and when the window gets focus). One import or enrich runs at a time, with up to `MAX_YT` (3) YouTube downloads beside it; edits wait up to 10 seconds for the library lock and are otherwise refused. A run that never reports back (server died) is marked failed after 2 hours (4 for enrich). The `/api/beets/agent/*` endpoints on the Worker skip Firebase sign-in and are protected only by the `X-Agent-Key` header, so keep the key secret.

One-time setup:
1. Pick a random key (`openssl rand -hex 32`) and store it as a Worker secret: `npx wrangler secret put BEETS_AGENT_KEY`. On Unraid save the same key, on one line, to `/boot/config/mymusic-agent.key` (`chmod 600`). `beets-enrich.sh` uses the same file.
2. Add this service to the compose stack, then `docker compose up -d mymusic-api`. CI builds the image on every push to `main` that changes `scripts/unraid/mymusic-api/` and publishes it to GitHub Container Registry (`ghcr.io/lyvuong/mymusic-api`; set the package to public in the repository's Packages settings, or `docker login ghcr.io` once on the server with a read-only token):
   ```yaml
   mymusic-api:
     image: ghcr.io/lyvuong/mymusic-api:latest
     container_name: mymusic-api
     restart: unless-stopped
     ports: ["8099:8099"]
     environment:
       - TZ=America/New_York
       - AUTO_IMPORT=1               # import by itself when files land in the inbox (off when unset)
       # - AUTO_IMPORT_DEBOUNCE=20   # seconds a file or folder must stay unchanged before it is imported
       # - MAX_YT=3                  # YouTube downloads at the same time
     labels:
       - com.centurylinklabs.watchtower.enable=true   # lets Watchtower (below) update this container
     volumes:
       - /boot/config/mymusic-agent.key:/run/mymusic-agent.key:ro
       - /var/run/docker.sock:/var/run/docker.sock       # it runs `docker exec beets ...`
       - /mnt/user/Music/_inbox:/inbox:ro                 # to watch and count the files; Beets does the moving
       - /mnt/user/appdata/beets:/beets-appdata           # auto-import.log, skipped.log, enrich.log, tag-edits.log
       - /tmp:/host-tmp                                   # shares /tmp/beets-import.lock with beets-enrich.sh
   ```
   The Docker socket gives this container root-level control of the server, which is why it only exposes the fixed endpoints behind the key and Cloudflare Access. Check it: `curl -H "X-Agent-Key: $(cat /boot/config/mymusic-agent.key)" http://localhost:8099/health` (it shows the running commit as `version`).

   **Updates**: add Watchtower to the stack so a new image is pulled and the container recreated within minutes of a merge, without giving GitHub any access to the server (the server only pulls):
   ```yaml
   watchtower:
     image: containrrr/watchtower:latest
     container_name: watchtower
     restart: unless-stopped
     command: --label-enable --interval 300 --cleanup
     environment:
       - DOCKER_API_VERSION=1.44   # Watchtower's built-in client is too old for current Docker ("client version 1.25 is too old")
     volumes:
       - /var/run/docker.sock:/var/run/docker.sock
   ```
   `--label-enable` limits it to containers with the label above, so it never touches Navidrome or Beets. Updating restarts `mymusic-api`: a run in progress is lost (the server recovers staged files at start and the app marks the run failed), so avoid merging API changes in the middle of a big import. Unraid's own "Docker Auto Update" plugin does the same job if you prefer it. The compose file, `config.yaml`, the tunnel and `beets-enrich.sh` stay manual.
3. Cloudflare Zero Trust: add a tunnel public hostname (`mymusic-api.lv5.uk`) pointing to `http://<unraid-ip>:8099` (or the container name if the tunnel runs in the same Docker network), and add it to the Access application/policy that allows the service token the Worker already uses for Navidrome.
4. `HOME_API_URL` in `wrangler.jsonc` is that hostname; pushing to `main` deploys it.
5. The Navidrome user in `NAS_USER` must be an **admin**, or "start scan" is refused and the app cannot trigger rescans after an import or an edit.

### YouTube import (container `yt-dlp`)
Organize has an "Add songs from YouTube" box (owner only): paste one or more links (one per line), **Look up** shows the title, artist and album yt-dlp found for each, edit them if needed, **Add to library**. Links can be added at any time, also while others are downloading: the Worker keeps them in a queue (`beets_runs`, status `requested`) and hands the server up to 3 at a time; the rest show "waiting for a free download slot". The server downloads the audio as mp3 (`yt-dlp` + `ffmpeg`, in the `yt-dlp` container), writes your names into the tags, and imports it into Beets *as it is* (`beet import -A -s`, no MusicBrainz matching, so the names stay exactly as confirmed); then the app scans Navidrome and syncs like after an Organize. One video per link (playlists are refused), up to 2 hours. Downloads, tagging and covers run in parallel, each in its own `_inbox/_youtube/<run id>` folder that Organize and the watcher never look into; only the final `beet import -A -s` step (the one that writes `musiclibrary.blb`) takes the library lock, so it waits for a running Organize or enrich and the other way round.

Add this service next to `beets`, then `docker compose up -d yt-dlp` (it reinstalls the newest yt-dlp every time it starts, because YouTube changes often; `docker restart yt-dlp` fixes "unable to extract" errors):
```yaml
yt-dlp:
  image: python:3.12-alpine
  container_name: yt-dlp
  restart: unless-stopped
  command: sh -c "apk add --no-cache ffmpeg nodejs >/dev/null && pip install -q --no-cache-dir -U 'yt-dlp[default]' && exec sleep infinity"
  environment: [TZ=America/New_York]
  volumes:
    - /mnt/user/Music/_inbox:/downloads                # read-write: downloads land in /downloads/_youtube/<run id>
```
Check it: `docker exec yt-dlp yt-dlp --version`, then try a link in the web app. The API passes `--js-runtimes node` to yt-dlp (YouTube needs a JavaScript runtime, and yt-dlp only looks for deno on its own); set the `YTDLP_ARGS` environment variable of `mymusic-api` to change or clear that. Downloads go to a private folder `_inbox/_youtube/<run id>` that is removed afterwards. Downloading from YouTube may go against its terms of service and copyright; use it for your own purposes only.

Logs on the server (all in `/mnt/user/appdata/beets/`): `auto-import.log` (imports and YouTube imports), `enrich.log` (enrich), `tag-edits.log` (name edits). `docker logs mymusic-api` shows the API's own requests.

### Navidrome (container `navidrome`, image `deluan/navidrome:latest`)
- Port `4533`. Data/db/cache: `/mnt/user/appdata/navidrome` -> `/data`. Music: `/mnt/user/Music` -> `/music` **read-only** (it never writes tags or deletes files).
- Env: `ND_LOGLEVEL=info`, `ND_BASEURL=""`, `ND_IMAGECACHESIZE=1000MB`, `ND_ENABLESHARING=true`, `ND_SCANSCHEDULE=1h`. The app starts a scan itself after an import and after a name edit; otherwise new files can take up to an hour to appear.
- It scans all of `/music`, so files waiting in `_inbox` (and the `_staging`, `_skipped` and `_youtube` folders inside it) are visible too. Excluding `_inbox` is not set up yet.
- The Worker reaches it through a Cloudflare Tunnel (`NAS_BASE_URL`, optional Cloudflare Access service token `NAS_CF_ACCESS_*`).
- Albums grayed out with a "?" are Navidrome's missing-files marker (files gone from disk). Remove them under user menu -> Missing Files (0.55+), then rescan.

### File Browser (container `filebrowser`, image `filebrowser/filebrowser:latest`)
- Port `8080` -> container `80`. Runs as `user: "0:0"` to bypass Unraid permission lockouts; healthcheck disabled.
- Root `/srv` = the whole `/mnt/user/Music` share, so uploads go to `/srv/_inbox` (host `/mnt/user/Music/_inbox`). Database: `/mnt/user/appdata/filebrowser` -> `/database`; config: `/mnt/user/appdata/filebrowser/config` -> `/config`.
- Reached on the LAN (no tunnel recorded here).

### Troubleshooting
1. **Everything in the inbox is skipped**: check `quiet_fallback` is `asis` in `config.yaml` (not `skip`), then `docker restart beets`.
2. **Import seems to finish instantly / "another job is running"**: an import or enrich holds `/tmp/beets-import.lock`. Check `docker exec beets pgrep -a beet`. Two import processes at once (for example a manual `beet import` in a terminal during an Organize run) fight over the same files; wait for one to end.
3. **Slow imports**: MusicBrainz is rate limited (~1 request/s). While sorting a very large inbox you can temporarily use `plugins: musicbrainz scrub`.
4. **Tags cannot be written over SMB (Mp3tag "cannot write") or by the app**: Beets runs as root, so imported files are `root:root` with `rw-r-----` and the SMB user `nobody` cannot write them. Fix: `chown -R nobody:users /mnt/user/Music && chmod -R u+rwX,g+rwX,o+rX /mnt/user/Music` (the same as Tools -> New Permissions), only while no import is running. To stop it coming back, set `PUID=99` and `PGID=100` on the `beets` service. In Mp3tag use ID3v2.3 with UTF-16 so Vietnamese text reads correctly everywhere.
5. **Grayed-out album with "?"**: Navidrome missing files; see the Navidrome section.
6. **Same artist in two folders by capitalisation** ("Berlin Orchestra" / "Berlin orchestra"): rename one to the other in the web app (it merges them), or use the script below to move the files into one folder.
7. **Dropped files are not imported by themselves**: `docker logs mymusic-api` should say `watching /inbox for new files` (needs `AUTO_IMPORT=1` and the image's `inotify-tools`). inotify sees writes made through `/mnt/user` (SMB, File Browser, other containers) but not writes straight to `/mnt/diskN` or a cache path. A folder is taken only after it has been quiet for `AUTO_IMPORT_DEBOUNCE` seconds.
8. **The app says the home server is unavailable**: the message is the reason (not configured, cannot reach, refused 403 = Access policy or key mismatch, 502/52x = container not running). Run the `curl .../health` check above on Unraid first, then check the tunnel hostname and the Access policy.

### Editing names and tags
- **In the web app** (small fixes, merging albums and artists): see "Editing names in the web app" below. It writes into the files and the Beets library through `mymusic-api`.
- **Mp3tag on the laptop** (bulk edits): over the SMB share `\\Lincoln-Unraid\Music` (File Browser cannot edit tags). Picard was tried and dropped: its web UI cannot type Vietnamese. Mp3tag: Tools -> Options -> Tags -> Mpeg, write **ID3v2.3 with UTF-16** so Vietnamese reads correctly in Navidrome and on Android. Writing needs the files to be writable by `nobody` (troubleshooting item 4). After editing: `docker exec beets beet update` (re-reads tags), `beet move` if the names changed, then press **Organize** in the web app. Do not edit while a Beets job is running. Quick fixes without a laptop: `beet modify` / `beet edit`.

### Fixing ASCII-typed Vietnamese in tags
`scripts/unraid/fix-vietnamese.py` (runs in the `beets` container, preview unless `--apply`) runs as the first step of every enrich (nightly and **Run enrich now**), or by hand as below. It decodes VIQR-style text in titles, artists and albums: `o*`/`o+` -> ơ, `u*`/`u+` -> ư, `a(` -> ă, `a^ e^ o^` -> â ê ô, `dd`/`d-` -> đ, tones `` ` ' ? ~ . ``, and `_20` -> space. Only fields with clear markers (`a^`, `o*`, `u+`, a backtick after a vowel, a word starting `dd`) are touched, so English titles stay as they are. In every Vietnamese field (decoded, or already real Vietnamese: it has `đ` or a tone/vowel mark) the first letter of each word is capitalised (`hương cần` -> `Hương Cần`). File names cannot contain `'`, `(` or `?`, so those marks became `_` and are lost: such fields are decoded as far as possible and listed in `/config/vietnamese-review.txt` for hand editing (Mp3tag or the web app). `--apostrophes` also restores `_` to `'` in English titles (`Let_s` -> `Let's`).

```bash
docker exec -i beets /lsiopy/bin/python3 - < /mnt/user/appdata/beets/fix-vietnamese.py            # preview
docker exec -i beets /lsiopy/bin/python3 - --apply < /mnt/user/appdata/beets/fix-vietnamese.py    # do it
```
Beets renames and moves the files to match the new tags; then press **Organize** in the web app. Songs imported with blank tags (`00 -.mp3`) have nothing to decode.

### Merging artists that differ only by capitals (and moving their files)
`scripts/unraid/merge-artist-case.py` runs inside the `beets` container. It lists every artist and album artist whose spelling differs only by case, keeps the most-used spelling and has Beets retag the others **and move the files into one folder** (the web app's rename does not move files). It is a preview unless `--apply` is given, and refuses to run during an import. Copy it to `/mnt/user/appdata/beets/merge-artist-case.py`, then:

```bash
docker exec -i beets python3 - < /mnt/user/appdata/beets/merge-artist-case.py            # preview
docker exec -i beets python3 - --apply < /mnt/user/appdata/beets/merge-artist-case.py    # do it
```

Afterwards press **Organize inbox and update library** in the web app (Navidrome rescan and sync). If both folders held the same songs, each song now exists twice in the merged folder; find them with `beet ls -f '$title | $length' albumartist:"Name" | sort` and remove the extras with `beet remove`. Moving files gives Navidrome new song ids, so playlists and ratings that point at the moved songs are lost; the web app's rename avoids that by not moving files.

## Editing names in the web app

Library tab: a song's **⋯ -> Edit details…** changes its title, artist, album and track number; an album or artist page has **✎ Rename / merge**. Typing a name that already exists merges the two (all songs move over and the empty album or artist disappears, because albums and artists are just the songs' names). Text is stored as Unicode NFC so Vietnamese diacritics compare equal. Any family member can edit.

Each edit is sent to the home server API first, which writes the tags into the files (and updates the Beets library) with Beets' own Python library, under the import lock. Only if that succeeds is the change stored in the app (the song is flagged `edited`, migration `0009`, so "Sync music from NAS" never restores the old names) and a Navidrome scan started. If the server cannot be reached the edit is refused with the reason and nothing changes.

- Files are **not moved**: a new path would give Navidrome a new song id and break playlists and ratings. Folder names keep the old spelling.
- Songs are matched by their old title/artist/album (case and diacritic-form tolerant). An ambiguous or missing match is skipped and reported, and only the app's copy changes.
- Songs uploaded to the app (not on the NAS) have no file on the server, so only the app's copy changes.
- Tags are written as the Beets config says (`id3v23` for ID3v2.3 with UTF-16, as the Mp3tag note above requires). Log: `/mnt/user/appdata/beets/tag-edits.log`.
- The phone gets the new names on its next sync.

### Album covers

An album page has **🖼 Add cover** (or **Replace cover** when it has one). The browser scales the picked image to at most 1000 px and sends it as JPEG; the Worker has the home server write it as `cover.jpg` into the folder(s) of the album's songs (an existing `cover.*`, `folder.*` or `front.*` image is kept as `old-<name>`), stores a copy in R2 so the cover shows at once, and starts a Navidrome scan. The next "Sync music from NAS" replaces the R2 copy with Navidrome's own. A folder that also holds songs of other albums gets no folder image (it would apply to all of them): the cover is embedded in that album's own song files instead (Navidrome shows embedded art only when the folder has no `cover.*`/`folder.*`/`front.*` image; the app warns when it has one). Like name edits, this is refused with the reason when the home server cannot be reached (albums made only of app uploads do not need it). The `mymusic-api` log is `/mnt/user/appdata/beets/tag-edits.log`.

## Ratings and AI suggestions

Every member rates songs 1-5 stars (web: stars on each row and in the player bar; phone: the song menu -> **Rate...** and the stars on the now-playing screen; tap the current star again to clear). Ratings are per person (table `ratings`, migration `0008_ratings.sql`) and the phone queues them while offline.

The **For you** tab asks `POST /api/suggest`, which sends the caller's ratings (favourite artists, loved and disliked songs) plus about 220 candidate songs from the family library to **Cloudflare Workers AI** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, free daily allowance, no API key). The answer is a themed playlist built only from songs in the library (the model picks candidate numbers, so it cannot invent songs), a reason per song, and a few artists to discover that are not in the library. An optional mood or occasion steers it. Needs the `ai` binding in `wrangler.jsonc` (already there) and at least 3 ratings or a mood. Change the model in `worker/suggest.ts`.

## Casting to a Google device (web app)

In Chrome or Edge the player bar shows a **Cast** button once a Chromecast or Google speaker is on the network. Choosing a device sends the current queue to it, so a whole playlist plays on in order (up to 500 songs from the current one, sent in pieces) even if the browser tab is closed; play, pause, seek, next and previous in the app then control the device. Stopping the cast brings the song back to the browser, paused.

- The device fetches the songs itself, so the Worker hands out signed, absolute URLs (`POST /api/cast/media`) that carry an HMAC instead of the login token. A URL is valid for 12 hours and only for that one song's audio or cover. The signing key is generated by the Worker and kept in D1 (`app_secrets`, migration `0010`), so nothing has to be configured.
- It uses the Default Media Receiver, so nothing is registered with Google. It needs HTTPS (the Worker URL is).
- Formats: MP3, AAC/M4A, FLAC, Opus and Vorbis play on Cast devices; WMA or ALAC may not. The Android app has no Cast button yet.

## Local development

```bash
cp .env.example .env.local        # Firebase web config
npm run db:migrate:local
npm run dev                       # Worker on :8787
npm run dev:web                   # web player on :5173, proxies /api to the Worker
cd flutter && flutter run --dart-define=API_URL=http://10.0.2.2:8787 --dart-define=GOOGLE_SERVER_CLIENT_ID=<id>
```

`wrangler dev` uses your real Workers AI and, if `HOME_API_URL` is set, your real home server; leave it empty locally to keep Organize, enrich and name editing disabled.

## Android Auto with a sideloaded build

Android Auto hides apps that did not come from the Play Store. On the phone: Android Auto settings, tap "Version" 10 times, open the developer settings and enable **Unknown sources**. Not needed for Play Store builds (use `--dart-define=STORE_BUILD=true`).

To try the app in a car-style UI on your PC, use the Desktop Head Unit from the Android SDK.
