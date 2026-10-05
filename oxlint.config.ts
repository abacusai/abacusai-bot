import base from "@abacus-ai/config/oxlint/base";
import node from "@abacus-ai/config/oxlint/node";
import { defineConfig } from "oxlint";

/** The old renderer's stack, removed at cut-over; never imported by the rewrite. */
const RENDERER_NEXT_BANNED_PACKAGES = [
  "electron",
  "framer-motion",
  "zustand",
  "sonner",
  "react-tourlight",
  "katex",
  "monaco-editor",
  "@monaco-editor/react",
  "uuid",
  "@lobehub/icons-static-svg",
];

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
        // The rewrite's tree is its own; the old one never reaches into it.
        "no-restricted-imports": [
          "error",
          {
            paths: [{ name: "#next", message: "renderer-next is separate" }],
            patterns: [
              {
                group: ["#next/*", "**/renderer-next/**"],
                message: "The old renderer does not import renderer-next.",
              },
            ],
          },
        ],
      },
    },
    // The rewrite (spec 01 §3.4): the React Compiler is on, so its rules are
    // errors, and the legacy stack is banned by import.
    {
      files: ["apps/desktop/src/renderer-next/**/*.{ts,tsx}"],
      env: { browser: true, node: false },
      plugins: ["react", "import"],
      rules: {
        "react/rules-of-hooks": "error",
        "react/jsx-key": "error",
        "react/no-children-prop": "error",
        "react-hooks/exhaustive-deps": "error",
        "react/set-state-in-effect": "error",
        "react/refs": "error",
        "react/purity": "error",
        "react/preserve-manual-memoization": "error",
        // No default exports except route files (PLAN "Structure").
        "import/no-default-export": "error",
        "no-restricted-imports": [
          "error",
          {
            paths: [
              ...RENDERER_NEXT_BANNED_PACKAGES.map((name) => ({
                name,
                message: "Not in renderer-next (spec 01 §3.4).",
              })),
              {
                name: "react",
                importNames: ["useMemo", "useCallback", "memo", "forwardRef"],
                message:
                  "The React Compiler memoises and React 19 forwards refs.",
              },
            ],
            patterns: [
              {
                group: [
                  "#renderer/*",
                  "**/renderer/**",
                  "!#locales/*",
                  "@dicebear/*",
                  "@tsparticles/*",
                  "@radix-ui/*",
                  "@base-ui/react/*",
                ],
                message:
                  "renderer-next reaches the old tree only through #locales/*; Base UI only inside ui/.",
              },
            ],
          },
        ],
      },
    },
    // Registry output: Base UI is imported here and nowhere else, and the
    // registry may memoise (it is never edited).
    {
      files: ["apps/desktop/src/renderer-next/ui/**/*.{ts,tsx}"],
      rules: {
        "react/preserve-manual-memoization": "off",
        "no-restricted-imports": [
          "error",
          {
            paths: RENDERER_NEXT_BANNED_PACKAGES.map((name) => ({
              name,
              message: "Not in renderer-next (spec 01 §3.4).",
            })),
            patterns: [
              {
                group: ["#renderer/*", "**/renderer/**"],
                message: "renderer-next does not import the old tree.",
              },
            ],
          },
        ],
      },
    },
    // File routes export `Route`; the router plugin reads them by name, and
    // these are the only files that may default-export at all.
    {
      files: ["apps/desktop/src/renderer-next/routes/**/*.tsx"],
      rules: { "import/no-default-export": "off" },
    },
  ],
});
