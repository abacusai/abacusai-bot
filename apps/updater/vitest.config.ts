import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // These cases build a TUF repository in a temp directory: several key
    // generations, signatures and file writes each. On a cold Windows runner
    // that is more than vitest's 5s default, and the timeout looks like a
    // signing bug rather than slow disk.
    testTimeout: 30_000,
  },
});
