import base from "@abacus-ai/config/oxlint/base";
import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

/**
 * Everything ultracite recommends: about 12,000 findings on this tree, almost
 * all stylistic, for whoever works through them via `pnpm lint:all`. CI gates
 * on ./base.ts instead — a gate nobody can pass gets switched off. Ignore
 * patterns are included so it runs without a wrapper at the repository root.
 */
export default defineConfig({
  extends: [core],
  ignorePatterns: base.ignorePatterns ?? [],
});
