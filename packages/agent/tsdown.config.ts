import { NATIVE_PACKAGES } from "@abacus-ai/config/native-packages";
import { defineConfig } from "tsdown";

/**
 * The agent is private and consumed only from this repository, so it ships as a
 * bundle rather than as a tree: the desktop app copies `dist/` beside its asar
 * and spawns `main.js` from there, and a directory of loose modules could not be
 * copied without its whole dependency graph coming too.
 *
 * Everything is inlined except the packages that load native code, which cannot
 * be — see @abacus-ai/config/native-packages.
 */
export default defineConfig({
  // usage-stats and custom-instructions are their own tiny entries: the
  // desktop's Electron main imports them directly (`@abacus-ai/agent/usage`,
  // `@abacus-ai/agent/custom-instructions`), and routing either through the
  // index would inline the whole agent bundle into the app's main process —
  // along with the native-addon packages the index leaves external, which do
  // not exist inside the app's asar. That is not a size regression, it is a
  // main process that cannot start (ERR_MODULE_NOT_FOUND @earendil-works/pi-tui,
  // shipped in 1.0.6).
  entry: [
    "src/index.ts",
    "src/main.ts",
    "src/usage-stats.ts",
    "src/custom-instructions.ts",
    // Same reason: the desktop's picker reads pi's model catalog
    // (`@abacus-ai/agent/model-catalog`) from Electron's main process.
    "src/model-catalog.ts",
    // And the same again: the terminal panel offers the bundled busybox as a
    // shell, so main installs it through
    // `@abacus-ai/agent/posix-shell-install`. That module imports no pi.
    "src/posix-shell-install.ts",
    // And whether this platform has a kernel sandbox, for the Settings page.
    "src/sandbox-support.ts",
  ],
  deps: {
    // The sandbox runtime finds its vendored seccomp filters and Java agent
    // relative to its own files, so it ships as a package beside the agent.
    neverBundle: [...NATIVE_PACKAGES, "@anthropic-ai/sandbox-runtime"],
    onlyBundle: false,
  },
  format: "esm",
  platform: "node",
  target: "node22",
  // `.js`, because `type: module` already says what that means and the desktop
  // app names the file it spawns.
  outExtensions: () => ({ js: ".js" }),
  // Two packages import this one through its `exports` map, so the build has to
  // carry types or every consumer sees `any`.
  dts: true,
  unbundle: false,
});
