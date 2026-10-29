import path from "node:path";

import { NATIVE_PACKAGES } from "@abacus-ai/config/native-packages";
import { defineConfig } from "tsdown";

import { writeBuildProvenance } from "../../scripts/build-provenance.mjs";

/**
 * The agent is private and consumed only from this repository, so it ships as a
 * bundle rather than as a tree: the desktop app copies `dist/` beside its asar
 * and spawns `main.js` from there, and a directory of loose modules could not be
 * copied without its whole dependency graph coming too.
 *
 * Everything is inlined except the packages that load native code, which cannot
 * be (see @abacus-ai/config/native-packages).
 */
export default defineConfig({
  onSuccess: () => writeBuildProvenance("dist"),
  // usage-stats and custom-instructions are their own tiny entries: the
  // desktop's Electron main imports them directly (`@abacus-ai/agent/usage`,
  // `@abacus-ai/agent/custom-instructions`), and routing either through the
  // index would inline the whole agent bundle into the app's main process,
  // along with the native-addon packages the index leaves external, which do
  // not exist inside the app's asar. The main process then cannot start
  // (ERR_MODULE_NOT_FOUND @earendil-works/pi-tui).
  entry: [
    "src/index.ts",
    "src/main.ts",
    "src/tls-trust.ts",
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
    // And the shared atomic write. Imports only node's fs, so main pays nothing.
    "src/atomic-file.ts",
    // Every child process's environment: no imports at all.
    "src/child-env.ts",
    // The renderer's tool titles, kinds and result formatting. Browser-safe:
    // no node or pi anywhere in its closure (tool-display.test.ts).
    "src/tool-display.ts",
    "src/user-text.ts",
    // How a path is spelled for the model; main and the renderer show it paths.
    "src/model-path.ts",
    // The language the user wants replies in, for the chat apps' fixed lines.
    "src/user-language.ts",
    // The phone reply's bubble split, for the hosted app's WhatsApp lane.
    "src/phone/phone-bubbles.ts",
    // The phone loop's zone, check-in language and due loops, for its agenda.
    "src/phone/phone-nudges.ts",
    // Media for the chat: the hosted app's lane and main's media store read it.
    "src/send-media.ts",
    // Whether a presented URL answers: main's present_deliverable asks it too.
    "src/deliverable-url.ts",
    // What a chat can do, and which tools it gets: main and its tests read them.
    "src/channel.ts",
    "src/tool-policy.ts",
    // The credential stores no deliverable may be read from.
    "src/sandbox/secrets.ts",
    // Saved travelers: main's browser types a passport number from it.
    "src/traveler/traveler-store.ts",
    // What the agent shell's rm, find, git clean, cmd and PowerShell run to
    // send deletes to the trash, once per command: node builtins only.
    "src/trash-shim.ts",
    // Libraries the agent's own Node scripts `require` (Word and Excel files),
    // one file each under dist/modules, which NODE_PATH names (bundled-tools.ts).
    "src/modules/docx.js",
    "src/modules/exceljs.js",
    "src/modules/jszip.js",
    "src/modules/mammoth.js",
  ],
  deps: {
    // The sandbox runtime finds its vendored seccomp filters and Java agent
    // relative to its own files, so it ships as a package beside the agent.
    neverBundle: [...NATIVE_PACKAGES, "@anthropic-ai/sandbox-runtime"],
    onlyBundle: false,
  },
  // Only exceljs imports it (its streaming reader); see the stub.
  alias: {
    unzipper: path.join(import.meta.dirname, "src/modules/unzipper-stub.cjs"),
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
