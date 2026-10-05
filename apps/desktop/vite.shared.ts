/**
 * Filters and aliases shared by vite.config.ts and vitest.config.ts (spec 01
 * §3.3, §3.7). Listed in tsconfig.vite.json because that project is composite.
 */
import { resolve } from "node:path";

/**
 * JS/TS modules of the new renderer only: the React Compiler instance's
 * `include`. A directory-only filter would hand it CSS ("Unexpected token").
 */
export const RENDERER_MODULES =
  /[\\/]apps[\\/]web[\\/]src[\\/].*\.[cm]?[jt]sx?$/;

/** Registry output stays byte-identical; the plain React instance refreshes it. */
export const RENDERER_REGISTRY_SRC = /[\\/]apps[\\/]web[\\/]src[\\/]ui[\\/]/;
export const RENDERER_APP_SRC = /[\\/]apps[\\/]web[\\/]src[\\/](?!ui[\\/])/;

export const NODE_MODULES = /[\\/]node_modules[\\/]/;

const root = import.meta.dirname;

/**
 * The roots package.json's `imports` declares. Repeated because Node's
 * subpath-imports resolution takes a target literally: it tries no extensions
 * and no index files, so `#renderer/components/ui` never finds
 * `components/ui/index.tsx` on its own.
 */
export const alias = {
  "#main": resolve(root, "src/main"),
  "#preload": resolve(root, "src/preload"),
  "#renderer": resolve(root, "../web/src"),
  // The one sanctioned path from renderer into the old tree (§9.1).
  "#locales": resolve(root, "../web/src/locales"),
  "@abacus-ai/contract": resolve(root, "../../packages/contract/src"),
};
