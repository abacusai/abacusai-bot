import { defineConfig } from "vitest/config";

import { hostAliases } from "./tsdown.config";
export default defineConfig({
  resolve: { alias: hostAliases },
  test: { environment: "node", include: ["src/**/*.test.ts"], maxWorkers: 1 },
});
