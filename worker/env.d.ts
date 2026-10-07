interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MUSIC: R2Bucket;
  RELEASES: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  AUTH_EMULATOR?: string;
  NAS_BASE_URL?: string;
  NAS_CF_ACCESS_ID?: string;
  NAS_CF_ACCESS_SECRET?: string;
  NAS_USER?: string;
  NAS_PASSWORD?: string;
}
