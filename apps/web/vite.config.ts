import { resolve } from "node:path";

import { defineConfig } from "vite";

import { rendererPlugins, rendererAlias, webRoot } from "./vite.renderer";
export default defineConfig(({ command }) => ({
  root: webRoot,
  base: "/web/",
  plugins: rendererPlugins("browser", command),
  resolve: { alias: rendererAlias, dedupe: ["react", "react-dom"] },
  build: {
    outDir: resolve(webRoot, "dist"),
    sourcemap: "hidden",
    rolldownOptions: { input: resolve(webRoot, "index.html") },
  },
  worker: { format: "es" },
}));
