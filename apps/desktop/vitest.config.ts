import { defaultExclude, defineConfig } from "vitest/config";

import { alias } from "./vite.shared.ts";

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
 * wall-clock timers for a browser pane to appear. In the `main` project, where
 * every file runs in parallel against a 5s default, a loaded macOS runner
 * kills the Electron spawn and the pane misses its window. The agent package
 * splits its spawning suites the same way.
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
  // Spawns several CLI children; fragmented stream timeouts need the machine alone.
  "src/main/services/session/cli-manager-taps.test.ts",
  "src/main/window-chrome.electron.test.ts",
  "src/main/services/browser/browser-snapshot.browser.test.ts",
  "src/main/services/mcp/mcp-browser-server.test.ts",
  // About renderer code, but it spawns the same Electron: the terminal grid
  // needs a canvas with a real cell size, which jsdom does not have.
  "src/main/ghostty-scrollback.browser.test.ts",
  // A timing measurement (spec 00 A-T8): run alone, or its median is noise.
  "src/main/rpc/serializer.bench.test.ts",
  // Spawns Electron for the real MessagePort handshake (spec 00 A-T12).
  "src/main/rpc/transports/rpc-handshake.electron.test.ts",
  // The one real-fs.watch test: FSEvents start-up latency stretches under the
  // parallel main project's load, so it runs here with the machine to itself.
  "src/main/rpc/tables/memories.fs.test.ts",
  // Drives the built renderer in Electron (spec 01 R1-T11b).
  "src/main/dev/renderer.electron.test.ts",
  "src/main/dev/chat-kit.electron.test.ts",
  "src/main/notch/notch.electron.test.ts",
  "src/main/dev/chat-real-session.electron.test.ts",
  // The migration kill-injection harness enumerates thousands of kill points
  // (spec 00 C); under the parallel project's load one matrix exceeds ten
  // minutes, so it runs alone with the 60 s per-test budget of this project.
  "src/main/migrations/runner.crash.test.ts",
];

export default defineConfig({
  test: {
    maxWorkers: process.env.CI ? 2 : 4,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      exclude: ["**/*.test.*", "**/dist/**", "**/*.config.ts"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "main",
          environment: "node",
          ...ciTimeouts,
          include: [
            "src/main/**/*.test.ts",
            "scripts/vite-resolution.test.ts",
            "scripts/renderer-csp.test.ts",
          ],
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
          sequence: { groupOrder: 1 },
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
    ],
  },
});
