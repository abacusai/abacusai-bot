/**
 * Filters and aliases shared by vite.config.ts and vitest.config.ts (spec 01
 * §3.3, §3.7). Listed in tsconfig.vite.json because that project is composite.
 */
import { resolve } from "node:path";

/** The whole new renderer tree: kept out of the old renderer's transform. */
export const NEXT_SRC = /[\\/]src[\\/]renderer-next[\\/]/;

/**
 * JS/TS modules of the new renderer only: the React Compiler instance's
 * `include`. A directory-only filter would hand it CSS ("Unexpected token").
 */
export const NEXT_MODULES = /[\\/]src[\\/]renderer-next[\\/].*\.[cm]?[jt]sx?$/;

/** Registry output uses the plain JSX transform; application code is compiled. */
export const NEXT_REGISTRY_SRC = /[\\/]src[\\/]renderer-next[\\/]ui[\\/]/;
export const NEXT_APP_SRC = /[\\/]src[\\/]renderer-next[\\/](?!ui[\\/])/;

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
  "#renderer": resolve(root, "src/renderer"),
  "#next": resolve(root, "src/renderer-next"),
  // The one sanctioned path from renderer-next into the old tree (§9.1).
  "#locales": resolve(root, "src/renderer/locales"),
  "#shared": resolve(root, "src/shared"),
  // The ONNX runtime's WebAssembly files are not in its export map, so the
  // transcriber reaches them through this alias. Hoisted node_modules, as
  // electron-builder.yml also relies on.
  "ort-dist": resolve(root, "../../node_modules/onnxruntime-web/dist"),
};
