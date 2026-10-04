import { resolve } from "node:path";

import { defineConfig } from "tsdown";
export const hostAliases = {
  electron: resolve(import.meta.dirname, "src/electron-shim.ts"),
  "electron-store": resolve(import.meta.dirname, "src/store.ts"),
  "#main": resolve(import.meta.dirname, "../desktop/src/main"),
  "@abacus-ai/contract": resolve(
    import.meta.dirname,
    "../../packages/contract/src"
  ),
};
export default defineConfig({
  entry: ["src/index.ts"],
  dts: false,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: hostAliases,
  outExtensions: () => ({ js: ".js" }),
  deps: {
    neverBundle: [
      "@lydell/node-pty",
      "@ff-labs/fff-node",
      "ffi-rs",
      "conf",
      "ws",
    ],
    alwaysBundle: [/^@abacus-ai\//],
    onlyBundle: false,
  },
  define: {
    "import.meta.env.ABACUS_WEB_HOST": "true",
    "import.meta.env.ABACUS_DEV_HARNESS": "false",
    "import.meta.env.DEV": "false",
  },
});
