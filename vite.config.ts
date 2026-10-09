import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Shown in the Family tab so you can tell which build you are running: the commit and the build time.
const commit = (process.env.GITHUB_SHA ?? (() => { try { return execSync("git rev-parse HEAD").toString(); } catch { return "dev"; } })()).trim().slice(0, 7);

// The Worker serves dist/ as static assets (wrangler.jsonc) and handles /api/*.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`${commit} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "MyMusic",
        short_name: "MyMusic",
        description: "Your family's music library",
        theme_color: "#14110d",
        background_color: "#14110d",
        display: "standalone",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] }, // never serve the app shell for API calls
    }),
  ],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } }, // `wrangler dev` on :8787
});
