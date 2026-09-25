import { defineConfig } from "oxlint";

import { BUILD_OUTPUT_IGNORES } from "../build-output-ignores.ts";

/**
 * What CI enforces: oxlint's `correctness` category (rules that find bugs
 * rather than opinions) plus four turned back on deliberately. Not ultracite's
 * full set: that is 12,000 mostly stylistic diagnostics on this tree, and a
 * gate nobody can pass gets switched off (`pnpm lint:all` runs it instead).
 */
export default defineConfig({
  categories: { correctness: "error" },
  // The `unicorn` and `react-perf` correctness rules are real but out of scope.
  plugins: ["eslint", "typescript", "react"],
  ignorePatterns: [
    ...BUILD_OUTPUT_IGNORES,
    "**/locales/**",
    // Third-party deck templates, carried unmodified.
    "apps/desktop/resources/**",
  ],
  rules: {
    // The four turned back on deliberately.
    "no-unused-vars": "error",
    "no-useless-escape": "error",
    "no-var": "error",
    "typescript/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
  },
});
