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
