import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defaultExclude, defineConfig } from "vitest/config";

/** See the note on `resolve.alias` in vite.config.ts. */
const alias = {
  "#main": resolve(import.meta.dirname, "src/main"),
  "#preload": resolve(import.meta.dirname, "src/preload"),
  "#renderer": resolve(import.meta.dirname, "src/renderer"),
  "#shared": resolve(import.meta.dirname, "src/shared"),
  "ort-dist": resolve(
    import.meta.dirname,
    "../../node_modules/onnxruntime-web/dist"
  ),
};

/**
 * Three surfaces, three environments. The renderer is browser code and needs a
 * DOM and the JSX transform; the main process and the shared contracts are plain
 * Node. A failure names the surface that broke.
 *
 * Nothing here reaches the public internet or a paid API: tests that need a
 * server start one on 127.0.0.1, and tests that need a model provider stub it.
 */
/**
 * Main-process suites that need the machine to themselves.
 *
 * One spawns a real Electron to measure real layout; the other waits on
 * wall-clock timers for a browser pane to appear. Both were in the `main`
 * project, where every file runs flat out against a 5s default — so on a
 * loaded macOS runner the Electron spawn was killed outright ("the harness
 * would not run") and the pane never arrived inside its window. Neither
 * failure said anything about the code under test, and they landed on
 * different runs, which is how a contention problem looks from the outside.
 *
 * The agent package already separates its spawning suites this way; this is
 * the same split for the desktop's.
 */
/**
 * Loaded CI runners take seconds where a dev machine takes milliseconds:
 * spawns of git, node workers, and plain file I/O have all flaked the 5s
 * default on windows-latest. CI gets room; local runs keep the tight
 * defaults so a hang still fails fast.
 */
const ciTimeouts = process.env.CI
  ? { hookTimeout: 30_000, testTimeout: 30_000 }
  : {};

const CONTENDS_FOR_THE_MACHINE = [
  "src/main/services/browser/browser-snapshot.browser.test.ts",
  "src/main/services/mcp/mcp-browser-server.test.ts",
  // About renderer code, but it spawns the same Electron: the terminal grid
  // needs a canvas with a real cell size, which jsdom does not have.
  "src/main/ghostty-scrollback.browser.test.ts",
];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      exclude: [
        "**/*.test.*",
        "**/dist/**",
        "**/*.config.ts",
        "src/renderer/locales/**",
      ],
    },
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "renderer",
          environment: "jsdom",
          ...ciTimeouts,
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/renderer/test-support/setup.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "main",
          environment: "node",
          ...ciTimeouts,
          include: ["src/main/**/*.test.ts"],
          exclude: [...defaultExclude, ...CONTENDS_FOR_THE_MACHINE],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "main-serial",
          environment: "node",
          ...ciTimeouts,
          include: CONTENDS_FOR_THE_MACHINE,
          // One at a time, and given room. See the note on the list above.
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "preload",
          environment: "node",
          ...ciTimeouts,
          include: ["src/preload/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "shared",
          environment: "node",
          ...ciTimeouts,
          include: ["src/shared/**/*.test.ts"],
        },
      },
    ],
  },
});
