import base from "@abacus-ai/config/oxlint/base";
import node from "@abacus-ai/config/oxlint/node";
import { defineConfig } from "oxlint";

/**
 * `extends` is only valid at the top level: inside an `overrides` entry oxlint
 * rejects it outright, so the renderer's React layer is spelled out here.
 */
export default defineConfig({
  extends: [base, node],
  ignorePatterns: base.ignorePatterns ?? [],
  // Repeated at the entry config: `plugins` in an extended config is additive,
  // so without this the unicorn and react-perf correctness rules come back.
  plugins: ["eslint", "typescript", "react"],
  options: { reportUnusedDisableDirectives: "deny" },
  overrides: [
    {
      files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
      env: { browser: true, node: false },
      // Just "react": oxlint implements the react-hooks rules inside its own
      // react plugin (its typings say so, and there is no react-hooks entry in
      // the built-in plugin list). Naming it separately was a type error, which
      // nothing noticed because no task type-checked this file.
      plugins: ["react"],
      rules: {
        // Hook order is correctness, not style.
        "react/rules-of-hooks": "error",
        "react/jsx-key": "error",
        "react/no-children-prop": "error",
        // A warning, as #223 set it: the findings are real but the fixes are a
        // sweep, and a warning still shows up in review.
        "react-hooks/exhaustive-deps": "warn",
        // The React Compiler rules report on patterns this codebase uses
        // deliberately. They were off before #223 and #223 left them off.
        "react/set-state-in-effect": "off",
        "react/refs": "off",
        "react/purity": "off",
        "react/preserve-manual-memoization": "off",
      },
    },
  ],
});
