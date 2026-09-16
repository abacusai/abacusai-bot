import { resolve } from "node:path";

import { NATIVE_PACKAGES } from "@abacus-ai/config/native-packages";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron, { simpleOptions } from "vite-plugin-electron/multi-env";

/** Loaded against Electron's own ABI, so never bundled. */
const ELECTRON_NATIVE = ["electron-store", "electron-updater"];

const root = import.meta.dirname;

export default defineConfig({
  build: { outDir: "dist/renderer" },
  plugins: [
    tailwindcss(),
    react(),
    ...electron(
      simpleOptions({
        main: {
          input: "src/main/index.ts",
          bundleDeps: {
            both: {
              exclude: [...NATIVE_PACKAGES, ...ELECTRON_NATIVE],
              // The experience update client must ship inside the main
              // bundle — nothing under resources/ provides these, and a bare
              // import of them in a packaged app fails at startup. Pinned
              // explicitly because the plugin otherwise leaves them
              // external, and the packaged-startup guard test enforces it.
              // The connector registry is TypeScript source shared with the
              // agent (a devDependency, like every workspace package); it
              // has no dist to resolve from the asar and must be inlined.
              include: ["extract-zip", "tuf-js", "@abacus-ai/connectors"],
            },
          },
          options: { build: { outDir: "dist/main" } },
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
              rolldownOptions: { output: { entryFileNames: "[name].cjs" } },
            },
          },
        },
      })
    ),
  ],
  resolve: {
    // The four roots package.json's `imports` declares. Repeated because Node's
    // subpath-imports resolution takes a target literally — it tries no
    // extensions and no index files, so `#renderer/components/ui` never finds
    // `components/ui/index.tsx` on its own.
    alias: {
      "#main": resolve(root, "src/main"),
      "#preload": resolve(root, "src/preload"),
      "#renderer": resolve(root, "src/renderer"),
      "#shared": resolve(root, "src/shared"),
    },
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" },
});
