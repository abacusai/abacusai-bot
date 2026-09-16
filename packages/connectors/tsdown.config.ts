import { defineConfig } from "tsdown";

/**
 * Built, not imported as source: both the agent bundle and the desktop's main
 * bundle inline this package, and their declaration builds need real `.d.ts`
 * files to resolve rather than another project's sources.
 */
export default defineConfig({
  entry: ["src/registry.ts", "src/describe.ts", "src/tool-meta.ts"],
  format: "esm",
  platform: "neutral",
  target: "node22",
  outExtensions: () => ({ js: ".js" }),
  dts: true,
  unbundle: false,
});
