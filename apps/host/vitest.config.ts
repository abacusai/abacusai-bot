import { defineConfig } from "vitest/config";

import { hostAliases } from "./tsdown.config";
export default defineConfig({
  define: { "import.meta.env.ABACUS_WEB_HOST": "true" },
  resolve: { alias: hostAliases },
  test: { environment: "node", include: ["src/**/*.test.ts"], maxWorkers: 1 },
});
