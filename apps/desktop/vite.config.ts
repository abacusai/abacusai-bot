import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { NATIVE_PACKAGES } from "@abacus-ai/config/native-packages";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ViteDevServer } from "vite";
import electron, { simpleOptions } from "vite-plugin-electron/multi-env";

import {
  alias,
  NEXT_MODULES,
  NEXT_APP_SRC,
  NEXT_REGISTRY_SRC,
  NODE_MODULES,
} from "./vite.shared.ts";

/** Loaded against Electron's own ABI, so never bundled. */
const ELECTRON_NATIVE = ["electron-store", "electron-updater"];

const root = import.meta.dirname;

// The dev server, for the relaunch check below.
let devServer: ViteDevServer | null = null;

/**
 * Seconds a relaunched app gets to reconnect before its predecessor's exit
 * is taken for a quit. Signing in as another account relaunches the app
 * (app.relaunch in main/handler.ts), and the plugin's default ends the dev
 * server with the Electron it spawned, stranding the relaunch on
 * "Couldn't load the app". A relaunched renderer reconnects to HMR within a
 * few seconds; a real quit leaves no client, and the server exits as before.
 */
const RELAUNCH_GRACE_MS = 8000;

// Hidden: written beside each bundle for generate-notices.js to read, never
// referenced from it and never packaged (see electron-builder.yml).
const sourcemap = "hidden";

export default defineConfig({
  build: {
    outDir: "dist/renderer",
    sourcemap,
    // Two documents: the shipped renderer and the rewrite's (spec 01 §3.3).
    // Both land at the root of dist/renderer, so the experience bundle
    // carries both unchanged.
    rolldownOptions: {
      input: {
        main: resolve(root, "index.html"),
        next: resolve(root, "index-next.html"),
      },
    },
  },
  plugins: [
    {
      name: "abacus:dev-server-handle",
      configureServer(server) {
        devServer = server;
      },
    },
    // Before the React transform: it rewrites route files into split chunks.
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/renderer-next/routes",
      generatedRouteTree: "./src/renderer-next/routeTree.gen.ts",
      routeFileIgnorePrefix: "-",
      autoCodeSplitting: true,
      quoteStyle: "double",
    }),
    tailwindcss(),
    // Order matters (spec 01 §3.3): the compiler instance first, the plain
    // instance last. Each sets oxc's refresh flag in its `config` hook and the
    // last one wins, so reversed, the old renderer loses Fast Refresh. The
    // compiler instance does its own refresh for the files it compiles.
    react({
      include: NEXT_MODULES,
      exclude: NEXT_REGISTRY_SRC,
      compiler: { logDiagnostics: true },
    }),
    react({ exclude: [NODE_MODULES, NEXT_APP_SRC] }),
    ...electron(
      simpleOptions({
        main: {
          input: "src/main/index.ts",
          onstart: async ({ startup }) => {
            await startup();
            // Mounted by the plugin's startup(); not in Node's own Process type.
            const child = (process as { electronApp?: ChildProcess })
              .electronApp;
            if (child == null) return;
            child.removeAllListeners("exit");
            child.once("exit", (code: number | null) => {
              setTimeout(() => {
                if ((devServer?.ws.clients.size ?? 0) === 0) process.exit(code);
                // The relaunch is not this server's child: the plugin's next
                // rebuild would message or kill the exited one and crash
                // (ERR_IPC_CHANNEL_CLOSED). A no-op stands in; renderer edits
                // still hot-reload, main/preload edits need a new `pnpm dev`.
                (process as { electronApp?: unknown }).electronApp = {
                  send: () => false,
                  kill: () => false,
                  on: () => undefined,
                  once: () => undefined,
                  removeAllListeners: () => undefined,
                };
                console.log(
                  "[dev] app relaunched itself; keeping the dev server (restart pnpm dev for main/preload changes)"
                );
              }, RELAUNCH_GRACE_MS);
            });
          },
          bundleDeps: {
            both: {
              exclude: [...NATIVE_PACKAGES, ...ELECTRON_NATIVE],
              // The experience update client must ship inside the main
              // bundle. Nothing under resources/ provides these, and a bare
              // import of them in a packaged app fails at startup. Pinned
              // because the plugin otherwise leaves them external; the
              // packaged-startup guard test enforces it.
              // The connector registry is TypeScript source shared with the
              // agent (a devDependency, like every workspace package); it
              // has no dist to resolve from the asar and must be inlined.
              // Main's AG-UI relay runs TanStack's StreamProcessor and
              // uiMessagesToWire (a devDependency the renderer shares), so it
              // is inlined with the packages it imports at run time.
              include: [
                "extract-zip",
                "tuf-js",
                "@abacus-ai/connectors",
                "@tanstack/ai",
                "@tanstack/ai-event-client",
                "@tanstack/ai-utils",
                "@ag-ui/core",
                "partial-json",
              ],
            },
          },
          options: { build: { outDir: "dist/main", sourcemap } },
        },
        preload: {
          input: "src/preload/index.ts",
          bundleDeps: { both: { exclude: ELECTRON_NATIVE } },
          // `.cjs`, not the plugin's default `.mjs`: the content it emits is
          // CommonJS, and Electron decides how to load a preload from the
          // extension. An .mjs file holding `require` calls fails at load.
          options: {
            build: {
              outDir: "dist/preload",
              sourcemap,
              rolldownOptions: { output: { entryFileNames: "[name].cjs" } },
            },
          },
        },
      })
    ),
  ],
  resolve: {
    // See vite.shared.ts.
    alias,
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" },
});
