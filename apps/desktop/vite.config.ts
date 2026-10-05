import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { NATIVE_PACKAGES } from "@abacus-ai/config/native-packages";
import { defineConfig, type ViteDevServer } from "vite";
import electron, { simpleOptions } from "vite-plugin-electron/multi-env";

import { rendererConfig, rendererFlags, webRoot } from "../web/vite.renderer";
import { alias } from "../web/vite.shared.ts";

/** Loaded against Electron's own ABI, so never bundled. */
const ELECTRON_NATIVE = ["electron-store", "electron-updater"];

const root = import.meta.dirname;

// multi-env's dev builder has configFile:false and no top-level resolve.alias.
// Vite aliases are global-only, so options.resolve.alias would be discarded.
// Rolldown plugins are retained in both modes; delegate extension/index lookup
// back to Vite after applying exactly the shared alias map.
const electronAliases = {
  name: "abacus:electron-aliases",
  resolveId: {
    order: "pre" as const,
    async handler(
      this: import("vite").Rolldown.PluginContext,
      id: string,
      importer: string | undefined
    ) {
      for (const [find, replacement] of Object.entries(alias)) {
        if (id === find || id.startsWith(`${find}/`))
          return this.resolve(replacement + id.slice(find.length), importer, {
            skipSelf: true,
          });
      }
      return null;
    },
  },
};

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

export default defineConfig(({ command, mode }) => {
  const { release } = rendererFlags(command);
  const renderer = rendererConfig("electron", command, mode);
  return {
    ...renderer,
    envDir: root,
    build: {
      outDir: resolve(root, "dist/renderer"),
      emptyOutDir: true,
      sourcemap,
      // Two documents: the shipped renderer and the rewrite's (spec 01 §3.3).
      // Both land at the root of dist/renderer, so the experience bundle
      // carries both unchanged.
      rolldownOptions: {
        input: {
          main: resolve(webRoot, "index.html"),
          notch: resolve(webRoot, "notch.html"),
        },
      },
    },
    plugins: [
      ...renderer.plugins,
      {
        name: "abacus:dev-server-handle",
        configureServer(server) {
          devServer = server;
        },
      },
      ...electron(
        simpleOptions({
          main: {
            input: resolve(root, "src/main/index.ts"),
            plugins: [electronAliases],
            onstart: async ({ startup }) => {
              await startup();
              // Mounted by the plugin's startup(); not in Node's own Process type.
              const child = (process as { electronApp?: ChildProcess })
                .electronApp;
              if (child == null) return;
              child.removeAllListeners("exit");
              child.once("exit", (code: number | null) => {
                setTimeout(() => {
                  if ((devServer?.ws.clients.size ?? 0) === 0)
                    process.exit(code);
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
                // is inlined with the packages it imports at run time, closed
                // transitively: `@tanstack/ai-event-client` imports
                // `@tanstack/devtools-event-client` at its top level, which
                // only tree-shaking (`sideEffects: false`) drops today.
                // The built-in MCP servers run on the MCP SDK (a
                // devDependency), inlined the same way with what it imports
                // at run time: its own zod, zod-to-json-schema (left behind
                // as a bare side-effect import otherwise), ajv and
                // ajv-formats with their CommonJS requires, content-type for
                // the media-type check, and @hono/node-server, whose
                // `hono/ws` import tree-shaking then drops. mcp-http-server.ts
                // imports it dynamically, so all of it lands in a chunk under
                // dist/main/assets rather than in the entry.
                include: [
                  "@abacus-ai/updater",
                  "extract-zip",
                  "tuf-js",
                  "@abacus-ai/connectors",
                  "@tanstack/ai",
                  "@tanstack/ai-event-client",
                  "@tanstack/devtools-event-client",
                  "@tanstack/ai-utils",
                  "@ag-ui/core",
                  "partial-json",
                  "@modelcontextprotocol/sdk",
                  "@hono/node-server",
                  "ajv",
                  "ajv-formats",
                  "content-type",
                  "fast-deep-equal",
                  "fast-uri",
                  "hono",
                  "json-schema-traverse",
                  "zod",
                  "zod-to-json-schema",
                ],
              },
            },
            options: {
              define: {
                "import.meta.env.ABACUS_WEB_HOST": "false",
                "import.meta.env.ABACUS_DEV_HARNESS": JSON.stringify(!release),
              },
              build: {
                outDir: resolve(root, "dist/main"),
                emptyOutDir: true,
                sourcemap,
              },
            },
          },
          preload: {
            input: resolve(root, "src/preload/index.ts"),
            plugins: [electronAliases],
            bundleDeps: { both: { exclude: ELECTRON_NATIVE } },
            // `.cjs`, not the plugin's default `.mjs`: the content it emits is
            // CommonJS, and Electron decides how to load a preload from the
            // extension. An .mjs file holding `require` calls fails at load.
            options: {
              build: {
                outDir: resolve(root, "dist/preload"),
                sourcemap,
                rolldownOptions: { output: { entryFileNames: "[name].cjs" } },
              },
            },
          },
        })
      ),
    ],
  };
});
