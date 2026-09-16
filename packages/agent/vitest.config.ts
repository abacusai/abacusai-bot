import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Every suite runs against an empty agent home. The modules under test read
 * ~/.abacusai-bot/config.json at call time for the keys the desktop stores at
 * sign-in — so on a developer machine with the app signed in, a test that
 * clears the key environment still found a real ABACUS_API_KEY, and
 * web/search.test.ts ran its "a query" fixtures against routellm for real:
 * ~20 billed searches per `pnpm test`, on whichever account was signed in.
 * CI never showed it, having no config.json. A suite that needs a home of its
 * own still sets ABACUSAI_BOT_HOME itself; this is the floor under the rest.
 */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "abacusai-bot-test-home-"));

/**
 * Suites that spawn a process, bind a socket, or ask the kernel something.
 * They are slow by nature and they contend with each other, so they run in
 * their own project with file parallelism off. Everything else is pure and
 * runs flat out.
 */
const SPAWNS_SOMETHING = [
  "src/**/*.e2e.test.ts",
  "src/**/*.integration.test.ts",
  "src/sandbox/sandbox.test.ts",
  "src/bundled-tools.test.ts",
  "src/static-server.test.ts",
  "src/background-processes.test.ts",
  // Spawns exactly what background-processes.test.ts does — the same
  // createLocalBashOperations, the same real `echo` — but it was left in the
  // `unit` project, where files run flat out against a 5s default. On a
  // contended Windows runner the spawn alone outran that, and three of its
  // tests timed out on nearly every run.
  "src/background-bash.test.ts",
];

export default defineConfig({
  test: {
    env: { ABACUSAI_BOT_HOME: EMPTY_HOME },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: SPAWNS_SOMETHING,
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: SPAWNS_SOMETHING,
          // One at a time: thirteen agents racing for the same CPU is how these
          // time out waiting for a child that has not been scheduled yet.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      exclude: ["**/*.test.*", "**/dist/**", "**/*.config.ts"],
    },
  },
});
