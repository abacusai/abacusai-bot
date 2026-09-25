import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

// An empty agent home for every suite: the code under test reads the keys the
// desktop stores at sign-in, and a test must never spend them.
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
  // Spawns what background-processes.test.ts does (the same
  // createLocalBashOperations, the same real `echo`). Against the unit
  // project's 5s default, the spawn alone times out on a contended Windows
  // runner.
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
