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
  /** Personal access token of a Discogs account (discogs.com/settings/developers); album suggestions skip Discogs without it. */
  DISCOGS_TOKEN?: string;
  /** Shared key between the Worker and the home server API (both directions). */
  BEETS_AGENT_KEY?: string;
  /** Public URL of the home server API (a Cloudflare Tunnel hostname). Empty = Beets features disabled. */
  HOME_API_URL?: string;
  /** YouTube downloads started on the home server at once (default 3; the server's own MAX_YT must be as high). Set in the dashboard
   * as a Secret-type variable, not in wrangler.jsonc: a deploy rewrites plain variables from that file but leaves secrets alone. */
  MAX_YOUTUBE?: string;
  /** Workers AI binding (free daily allowance); suggestions are disabled without it. */
  /** Cloudflare Images binding: resizes covers for the car. Without it the original cover is served. */
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(o: { width?: number; height?: number; fit?: string }): {
        output(o: { format: string; quality?: number }): Promise<{ response(): Response }>;
      };
    };
  };
  AI?: { run(model: string, input: unknown): Promise<unknown> };
}
