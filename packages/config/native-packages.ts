/**
 * Packages that load a `.node` addon or `.wasm` file at run time. A bundler
 * cannot inline a binary, and a loader that finds its asset relative to itself
 * breaks when moved, so these stay dependencies and seed every `external` list.
 */
export const NATIVE_PACKAGES = [
  "@ast-grep/lang-python",
  "@ast-grep/napi",
  "@earendil-works/pi-tui",
  "@ff-labs/fff-node",
  "@mariozechner/clipboard",
  "@silvia-odwyer/photon-node",
  "@lydell/node-pty",
  "ffi-rs",
] as const;
