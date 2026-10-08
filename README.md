# MyMusic

[![CI](https://github.com/lyvuong/MyMusic/actions/workflows/ci.yml/badge.svg)](https://github.com/lyvuong/MyMusic/actions/workflows/ci.yml)
![Platform: Android](https://img.shields.io/badge/platform-Android-3DDC84?logo=android&logoColor=white)
![Flutter](https://img.shields.io/badge/Flutter-02569B?logo=flutter&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Navidrome](https://img.shields.io/badge/Navidrome-NAS-0084ff)

A family music app: Android app (with Android Auto and offline downloads), a web player, and a Cloudflare Worker backend.

- `worker/`: Hono Worker. Firebase sign-in, families (D1), library, playlists, library sync and Range streaming from a Navidrome NAS (through a Cloudflare Tunnel), app releases.
- `src/`: web player (React + Vite PWA), served by the Worker as static assets.
- `flutter/`: Android app (`audio_service` + `just_audio`, Android Auto browse tree, offline downloads).
- `.github/workflows/ci.yml`: checks on every push; on `main` it deploys the Worker and publishes a signed APK.

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

## Home server (Unraid: Navidrome, File Browser, Beets)

Host `Lincoln-Unraid`. Music lives in the share `/mnt/user/Music`. The Worker only talks to Navidrome (Subsonic API, via a Cloudflare Tunnel, see `NAS_*` in `worker/env.d.ts`). Never put passwords or tokens in this file.

Flow: drop files in `/mnt/user/Music/_inbox` (File Browser) -> Beets organizes them into `/mnt/user/Music/Artist/Album/` -> Navidrome rescans -> sync the NAS in the web player (owner) -> the app shows them.

### Beets (container `beets`, image `lscr.io/linuxserver/beets:latest`)
- Mounts: `/mnt/user/appdata/beets` -> `/config`, `/mnt/user/Music` -> `/music`, `/mnt/user/Music/_inbox` -> `/downloads`.
- Config: `/mnt/user/appdata/beets/config.yaml` (library `/config/musiclibrary.blb`, log `/config/beet.log`). Library directory `/music`.
- Plugins: `musicbrainz fetchart embedart scrub lastgenre`. Paths: `$albumartist/$album%aunique{}/$track - $title`; singles go to `Non-Album/$artist - $title` (only for `-s` singleton imports; the scheduled job uses `-g`, so loose files are grouped as albums by their tags); compilations to `Compilations/...`.
- Import settings: `copy: no`, `move: yes` (files LEAVE `_inbox` once imported), `quiet_fallback: asis`, `resume: no`, `incremental: no`, `strong_rec_thresh: 0.15`. `asis` is needed: with `skip`, quiet mode silently skipped everything beets could not match.
- Scheduled job: User Scripts plugin, script `OrganizeMusicFiles`, runs every 15 minutes:
  ```bash
  #!/bin/bash
  flock -n /tmp/beets-import.lock \
    docker exec beets beet import -g -q /downloads >> /mnt/user/appdata/beets/auto-import.log 2>&1
  ```
  Paths in the command are container paths (`/downloads`, not `_inbox`). `flock -n` makes a run exit instantly while a previous import still holds the lock (a long run makes the next runs "finish" in 0 seconds; that is normal). Check with `docker exec beets pgrep -a beet`. A running `beet` reads the config only at start; restart the container after editing `config.yaml`.
- Matching notes: beets matches on existing tags/filenames via MusicBrainz (about 1 request/s, so big batches are slow). Files with junk tags (`05. Track 5.mp3`), loose single tracks, and many Vietnamese songs (diacritics stripped, weak coverage) do not match and are imported as-is as albums under whatever tags they carry (empty tags end up under an `Unknown Artist`/empty-album folder, not `Non-Album/`). Find them with `docker exec beets beet ls -f '$artist | $album | $title | $path'` and queries like `albumartist::^$` or `album::^$`.
- Chroma (audio fingerprinting): the `chroma` plugin identifies songs with junk tags/filenames via Chromaprint + AcoustID, which plain tag matching cannot. The image already has `/usr/bin/fpcalc` and `pyacoustid`, so no installs are needed. Setup: add `chroma` to `plugins:` (`musicbrainz chroma fetchart embedart scrub lastgenre`), add `chroma:` with `auto: yes`, then `docker restart beets` and confirm with `docker exec beets beet version`. Adds one lookup per file (slower imports). It cannot help for recordings MusicBrainz/AcoustID do not know (many Vietnamese songs). Re-match existing as-is files with `docker exec -it beets beet import -L album::^$` (or a query on the folder/artist you find with `beet ls`).
- Album art (fetchart/embedart): both run automatically on import only. `fetchart: auto: yes, minwidth: 500` (smaller covers are rejected); `embedart: auto: yes`; cover file name `cover` (`art_filename`). For albums already in the library run `docker exec beets beet fetchart` (add `-f` to replace existing covers, or a query like `albumartist:"Paul Simon"`), then `docker exec beets beet embedart` to write the cover into the files. Rescan Navidrome and re-sync the app afterwards. Albums that match nothing get no cover; the web player's "Find missing covers online" button (iTunes search) fills those in.
- Later clean-up: `beet import -L [query]` re-matches albums already in the library; after retagging run `beet update` then `beet move`. Rescan Navidrome and re-sync the app afterwards.

### Compose stack
One `compose.yaml` runs three containers: `navidrome`, `filebrowser`, `beets` (all `restart: unless-stopped`, all `:latest` images). Beets runs as root (`PUID=0`, `PGID=0`, `TZ=America/New_York`) like File Browser, so it can write to files File Browser uploaded.

### Fixes applied to the server (Oct 8, 2026) and troubleshooting
1. **Nothing was organized**: `config.yaml` had `quiet_fallback: skip`, so the scheduled `-q` import silently skipped every album beets could not confidently match. Changed to `quiet_fallback: asis` and `resume: ask` -> `resume: no` (a scheduled job cannot answer prompts). Backup of the old file: `config.yaml.bak`.
2. **Scheduled runs "finished" in 0 seconds**: the first import (started with the old config) was still running and held `/tmp/beets-import.lock`, so `flock -n` skipped every later run. Fixed with `docker restart beets` and running the script again. Beets reads `config.yaml` only at start, so always restart the container (or wait for the running import) after editing it.
3. **Slow imports**: MusicBrainz is rate limited (~1 request/s) and `fetchart`/`lastgenre` add a lookup per album. Optional speed-up while sorting a big inbox: `plugins: musicbrainz scrub`.
4. **Albums with junk tags** (`05. Track 5.mp3`, `- Unknown 2 -.mp3`, many Vietnamese songs) import as-is. Fix them later by retagging (Mp3tag or `beet modify`), then `beet import -L`, `beet update`, `beet move`.
5. **Grayed-out album with "?"**: Navidrome missing files; see the Navidrome section below.
6. **Untagged files stay in `_inbox` ("This album is already in the library! Skipping.")**: songs with no tags all have a blank artist and album, so after the first as-is import every other one looks like a duplicate of it. They are not real duplicates (checked by checksum). Fix: add the `fromfilename` plugin (title from the file name) and import them as singletons: `beet import -s -q /downloads`. The `singleton` path is `Non-Album/%if{$artist,$artist - }$title` so a missing artist does not give ` - Title.mp3`. The skip reasons are in the log written by `-l /config/skipped.log`.
7. **Tags cannot be written over SMB (Mp3tag "cannot write")**: Beets runs as root, so imported files are `root:root` with `rw-r-----` and the SMB user `nobody` cannot write them. Fix: `chown -R nobody:users /mnt/user/Music && chmod -R u+rwX,g+rwX,o+rX /mnt/user/Music` (the same as Tools -> New Permissions), only while no import is running. To stop it coming back, set `PUID=99` and `PGID=100` on the `beets` service. In Mp3tag use ID3v2.3 with UTF-16 so Vietnamese text reads correctly everywhere.
8. **Two import processes at once** (an old scheduled script plus a manual run) fight over the same files. Check with `docker exec beets pgrep -a beet`; the `beet web` line is only the Beets browser UI and is not needed.
9. **Same artist in two folders by capitalisation** ("Berlin Orchestra" / "Berlin orchestra"): see the next section.

### Fixing ASCII-typed Vietnamese in tags
`scripts/unraid/fix-vietnamese.py` (runs in the `beets` container, preview unless `--apply`) decodes VIQR-style text in titles, artists and albums: `o*`/`o+` -> ơ, `u*`/`u+` -> ư, `a(` -> ă, `a^ e^ o^` -> â ê ô, `dd`/`d-` -> đ, tones `` ` ' ? ~ . ``, and `_20` -> space. Only fields with clear markers (`a^`, `o*`, `u+`, a backtick after a vowel, a word starting `dd`) are touched, so English titles stay as they are. File names cannot contain `'`, `(` or `?`, so those marks became `_` and are lost: such fields are decoded as far as possible and listed in `/config/vietnamese-review.txt` for hand editing in Mp3tag. `--apostrophes` also restores `_` to `'` in English titles (`Let_s` -> `Let's`).

```bash
docker exec -i beets /lsiopy/bin/python3 - < /mnt/user/appdata/beets/fix-vietnamese.py            # preview
docker exec -i beets /lsiopy/bin/python3 - --apply < /mnt/user/appdata/beets/fix-vietnamese.py    # do it
```
Beets renames and moves the files to match the new tags; then press **Organize** in the web app. Songs imported with blank tags (`00 -.mp3`) have nothing to decode.

### Merging artists that differ only by capitals
`scripts/unraid/merge-artist-case.py` runs inside the `beets` container. It lists every artist and album artist whose spelling differs only by case, keeps the most-used spelling and has Beets retag the others and move the files into one folder. It is a preview unless `--apply` is given, and refuses to run during an import. Copy it to `/mnt/user/appdata/beets/merge-artist-case.py`, then:

```bash
docker exec -i beets python3 - < /mnt/user/appdata/beets/merge-artist-case.py            # preview
docker exec -i beets python3 - --apply < /mnt/user/appdata/beets/merge-artist-case.py    # do it
```

Afterwards press **Organize inbox and update library** in the web app (Navidrome rescan and sync). If both folders held the same songs, each song now exists twice in the merged folder; find them with `beet ls -f '$title | $length' albumartist:"Name" | sort` and remove the extras with `beet remove`.

### Navidrome (container `navidrome`, image `deluan/navidrome:latest`)
- Port `4533`. Data/db/cache: `/mnt/user/appdata/navidrome` -> `/data`. Music: `/mnt/user/Music` -> `/music` **read-only** (it never writes tags or deletes files).
- Env: `ND_LOGLEVEL=info`, `ND_BASEURL=""`, `ND_IMAGECACHESIZE=1000MB`, `ND_ENABLESHARING=true`, `ND_SCANSCHEDULE=1h` (new files can take up to an hour to appear unless you trigger a rescan from the UI).
- It scans all of `/music`, so files still waiting in `_inbox` are visible too. Excluding `_inbox` is not set up yet.
- The Worker reaches it through a Cloudflare Tunnel (`NAS_BASE_URL`, optional Cloudflare Access service token `NAS_CF_ACCESS_*`; tunnel hostname not recorded here).
- Albums grayed out with a "?" are Navidrome's missing-files marker (files gone from disk). Remove them under user menu -> Missing Files (0.55+), then rescan.

### Editing tags (Mp3tag on the laptop)
- Tags are edited with Mp3tag on Windows over the SMB share `\\Lincoln-Unraid\Music` (File Browser cannot edit tags). Picard was tried and dropped: its web UI cannot type Vietnamese. It is no longer in the compose stack.
- Mp3tag: Tools -> Options -> Tags -> Mpeg, write **ID3v2.3 with UTF-16** so Vietnamese reads correctly in Navidrome and on Android. Writing needs the files to be writable by `nobody` (see troubleshooting item 7 above).
- After editing: `docker exec beets beet update` (re-reads tags), `beet move` if the names changed, then press **Organize** in the web app. Do not edit while a Beets import is running. Quick fixes without a laptop: `beet modify` / `beet edit`.

### File Browser (container `filebrowser`, image `filebrowser/filebrowser:latest`)
- Port `8080` -> container `80`. Runs as `user: "0:0"` to bypass Unraid permission lockouts; healthcheck disabled.
- Root `/srv` = the whole `/mnt/user/Music` share, so uploads go to `/srv/_inbox` (host `/mnt/user/Music/_inbox`). Database: `/mnt/user/appdata/filebrowser` -> `/database`; config: `/mnt/user/appdata/filebrowser/config` -> `/config`.
- Reached on the LAN (no tunnel recorded here).

### Beets runs from the web app

Family tab (owner only) -> **Organize inbox and update library**: runs Beets on the inbox, then starts a Navidrome scan, then runs "Sync music from NAS", and shows the status and a log tail ("Beets history"). The Worker cannot reach the server, so the server pulls: the button queues a run in D1 (`beets_runs`), the Unraid script `scripts/unraid/beets-agent.sh` polls the Worker every minute, runs `beet import -g -q /downloads` and reports back (files in the inbox before/after, exit code, last 6000 characters of output). Only outgoing HTTPS requests are made; nothing is exposed. A click can take up to a minute to start.

One-time setup:
1. Pick a random key and store it as a Worker secret: `npx wrangler secret put BEETS_AGENT_KEY` (Worker secrets survive CI deploys).
2. On Unraid save the same key, on one line, to `/boot/config/mymusic-agent.key` (`chmod 600`).
3. Unraid -> Settings -> User Scripts -> add a script `beets-agent`, paste `scripts/unraid/beets-agent.sh`, schedule **Custom** `* * * * *`. Check `API`, `INBOX` and the container name `beets` at the top of the script.
4. The Navidrome user in `NAS_USER` must be an **admin**, or "start scan" is refused and the button stops after Beets finishes.
5. Push to `main`: CI applies migration `0005_beets_runs.sql` and deploys the Worker and web app.

Notes: the agent shares `/tmp/beets-import.lock` with the 15-minute scheduled import, so the two never overlap; the agent takes only one run at a time. A run that never reports back (server or script died) is marked failed after 2 hours. Imports are quiet (`-q`) and cannot ask questions; anything that needs a human choice still goes through Mp3tag or `beet import -L` in a terminal. The agent endpoints (`/api/beets/agent/*`) skip Firebase sign-in and are protected only by the `X-Agent-Key` header, so keep the key secret.

## Local development

```bash
cp .env.example .env.local        # Firebase web config
npm run db:migrate:local
npm run dev                       # Worker on :8787
npm run dev:web                   # web player on :5173, proxies /api to the Worker
cd flutter && flutter run --dart-define=API_URL=http://10.0.2.2:8787 --dart-define=GOOGLE_SERVER_CLIENT_ID=<id>
```

## Android Auto with a sideloaded build

Android Auto hides apps that did not come from the Play Store. On the phone: Android Auto settings, tap "Version" 10 times, open the developer settings and enable **Unknown sources**. Not needed for Play Store builds (use `--dart-define=STORE_BUILD=true`).

To try the app in a car-style UI on your PC, use the Desktop Head Unit from the Android SDK.
