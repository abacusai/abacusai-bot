/**
 * The hosted web app's browser build: the same renderer as the desktop, from
 * `web.html`, served by the web host's gateway under `/bot/`. No Electron, no
 * notch; the renderer reaches its server over a WebSocket instead of a port
 * (renderer/lib/web-app.ts). The server side is scripts/build-web-host.mjs.
 *
 *   pnpm --filter @abacus-ai/desktop build:web
 */
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import {
  alias,
  NODE_MODULES,
  RENDERER_APP_SRC,
  RENDERER_MODULES,
  RENDERER_REGISTRY_SRC,
} from "./vite.shared.ts";

const root = import.meta.dirname;

export default defineConfig({
  base: process.env.ABACUSAI_BOT_WEB_BASE_URL ?? "/bot/",
  publicDir: resolve(root, "web-public"),
  define: {
    "import.meta.env.VITE_WEB_APP": JSON.stringify("1"),
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: "hidden",
    rolldownOptions: {
      input: { web: resolve(root, "web.html") },
    },
  },
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/renderer/routes",
      generatedRouteTree: "./src/renderer/routeTree.gen.ts",
      routeFileIgnorePrefix: "-",
      autoCodeSplitting: true,
      quoteStyle: "double",
    }),
    tailwindcss(),
    react({
      include: RENDERER_MODULES,
      exclude: RENDERER_REGISTRY_SRC,
      compiler: { logDiagnostics: true },
    }),
    react({ exclude: [NODE_MODULES, RENDERER_APP_SRC] }),
  ],
  resolve: {
    alias,
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" },
});
