#!/usr/bin/env node
/**
 * Builds the hosted web app's server: the gateway and the per-user host
 * (src/web-host) into dist/web-host, next to dist/main so the paths main
 * computes from its own location (resources/, the agent bundle) still hold.
 *
 *   node apps/desktop/scripts/build-web-host.mjs
 *
 * `electron` resolves to src/web-host/electron-shim.ts. The two packages
 * that load Electron themselves are bundled so they get the shim too; every
 * other package stays external and loads from node_modules at run time.
 * The browser side is the `web` Vite build (vite.web.config.ts).
 */
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "rolldown";

import { alias } from "../vite.shared.ts";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = join(DESKTOP, "src", "web-host", "electron-shim.ts");

/** Bundled rather than external: they `require("electron")` themselves. */
const BUNDLED = [
  /^electron-store($|\/)/,
  /^electron-updater($|\/)/,
  /^conf($|\/)/,
  /^@abacus-ai\//,
];

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const isExternal = (id) => {
  if (id === "electron") return false;
  if (builtins.has(id)) return true;
  if (id.startsWith(".") || id.startsWith("/") || id.startsWith("#"))
    return false;
  if (id.startsWith("\0")) return false;
  return !BUNDLED.some((pattern) => pattern.test(id));
};

await build({
  input: {
    gateway: join(DESKTOP, "src", "web-host", "gateway.ts"),
    host: join(DESKTOP, "src", "web-host", "host.ts"),
  },
  platform: "node",
  external: isExternal,
  resolve: { alias: { ...alias, electron: SHIM } },
  transform: {
    define: { "import.meta.env.ABACUS_DEV_HARNESS": "false" },
  },
  output: {
    dir: join(DESKTOP, "dist", "web-host"),
    format: "esm",
    entryFileNames: "[name].js",
    sourcemap: true,
  },
});

console.log("[build-web-host] wrote dist/web-host");
