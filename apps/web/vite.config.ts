import { resolve } from "node:path";

import { defineConfig } from "vite";

import {
  rendererChunkGroups,
  rendererConfig,
  webRoot,
} from "./vite.renderer.ts";
export default defineConfig(({ command, mode }) => ({
  ...rendererConfig("browser", command, mode),
  base: "/bot/",
  build: {
    outDir: resolve(webRoot, "dist"),
    sourcemap: false,
    rolldownOptions: {
      input: resolve(webRoot, "index.html"),
      output: { codeSplitting: rendererChunkGroups },
    },
  },
}));
