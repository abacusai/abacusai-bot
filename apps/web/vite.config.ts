import { resolve } from "node:path";

import { defineConfig } from "vite";

import {
  rendererPlugins,
  rendererAlias,
  platformAlias,
  webRoot,
} from "./vite.renderer";
export default defineConfig(({ command, mode }) => ({
  root: webRoot,
  base: "/bot/",
  plugins: rendererPlugins("browser", command, mode),
  resolve: {
    alias: { ...rendererAlias, ...platformAlias("browser") },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: resolve(webRoot, "dist"),
    sourcemap: false,
    rolldownOptions: { input: resolve(webRoot, "index.html") },
  },
  worker: { format: "es" },
}));
