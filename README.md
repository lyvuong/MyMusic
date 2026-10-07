# MyMusic

A family music app: Android app (with Android Auto and offline downloads), a web player, and a Cloudflare Worker backend.

- `worker/`: Hono Worker. Firebase sign-in, families (D1), library, playlists, upload, Range streaming from R2, app releases.
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
