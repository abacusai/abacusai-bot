import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { NATIVE_PACKAGES } from "@abacus-ai/config/native-packages";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ViteDevServer } from "vite";
import electron, { simpleOptions } from "vite-plugin-electron/multi-env";

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

// The ONNX runtime's WebAssembly files are not in its export map, so the
// transcriber reaches them through this alias. Hoisted node_modules, as
// electron-builder.yml also relies on.
const ortDist = resolve(root, "../../node_modules/onnxruntime-web/dist");

// Hidden: written beside each bundle for generate-notices.js to read, never
// referenced from it and never packaged (see electron-builder.yml).
const sourcemap = "hidden";

export default defineConfig({
  build: { outDir: "dist/renderer", sourcemap },
  plugins: [
    {
      name: "abacus:dev-server-handle",
      configureServer(server) {
        devServer = server;
      },
    },
    tailwindcss(),
    react(),
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
              include: ["extract-zip", "tuf-js", "@abacus-ai/connectors"],
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
    // The four roots package.json's `imports` declares. Repeated because Node's
    // subpath-imports resolution takes a target literally: it tries no
    // extensions and no index files, so `#renderer/components/ui` never finds
    // `components/ui/index.tsx` on its own.
    alias: {
      "#main": resolve(root, "src/main"),
      "#preload": resolve(root, "src/preload"),
      "#renderer": resolve(root, "src/renderer"),
      "#shared": resolve(root, "src/shared"),
      "ort-dist": ortDist,
    },
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" },
});
