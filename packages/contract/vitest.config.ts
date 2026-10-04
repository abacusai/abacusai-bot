import { resolve } from "node:path";

import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: { "@abacus-ai/contract": resolve(import.meta.dirname, "src") },
  },
  test: { name: "shared", environment: "node", include: ["src/**/*.test.ts"] },
});
