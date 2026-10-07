import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The Worker serves dist/ as static assets (wrangler.jsonc) and handles /api/*.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "MyMusic",
        short_name: "MyMusic",
        description: "Your family's music library",
        theme_color: "#4527a0",
        background_color: "#121212",
        display: "standalone",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] }, // never serve the app shell for API calls
    }),
  ],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } }, // `wrangler dev` on :8787
});
