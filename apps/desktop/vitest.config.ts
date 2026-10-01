import react from "@vitejs/plugin-react";
import { defaultExclude, defineConfig } from "vitest/config";

import { alias, NEXT_MODULES } from "./vite.shared.ts";

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
  // Drives the built renderer-next in Electron (spec 01 R1-T11b).
  "src/main/dev/renderer-next.electron.test.ts",
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
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      exclude: [
        "**/*.test.*",
        "**/dist/**",
        "**/*.config.ts",
        "src/renderer/locales/**",
        "src/renderer-next/routeTree.gen.ts",
        "src/renderer-next/ui/**",
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
        // The rewrite's renderer (spec 01 §3.7): compiled as it ships.
        plugins: [react({ include: NEXT_MODULES, compiler: true })],
        resolve: { alias },
        test: {
          name: "renderer-next",
          environment: "jsdom",
          // Tests read tokens.css as text (`?raw`); nothing is styled.
          css: { include: [/tokens\.css/] },
          ...ciTimeouts,
          include: ["src/renderer-next/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/renderer-next/test-support/setup.ts"],
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
