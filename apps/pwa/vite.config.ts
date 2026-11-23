import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: { proxy: { "/graphql": "http://127.0.0.1:8787", "/files": "http://127.0.0.1:8787" } },
  build: { outDir: "dist", sourcemap: true },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Öppna företagsdata",
        short_name: "Öppna data",
        description: "Företag, arbetsställen och områden ur svenska öppna myndighetsdata.",
        lang: "sv",
        theme_color: "#14532d",
        background_color: "#f7f7f4",
        display: "standalone",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/(graphql|mcp|files|api|admin|watch|healthz)/],
        runtimeCaching: [
          { urlPattern: ({ url }) => url.hostname.endsWith("openfreemap.org"), handler: "StaleWhileRevalidate", options: { cacheName: "map", expiration: { maxEntries: 2000, maxAgeSeconds: 14 * 86400 } } },
        ],
      },
    }),
  ],
});
