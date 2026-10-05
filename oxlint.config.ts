import base from "@abacus-ai/config/oxlint/base";
import node from "@abacus-ai/config/oxlint/node";
import { defineConfig } from "oxlint";

/** The old renderer's stack, removed at cut-over; never imported by the rewrite. */
const RENDERER_BANNED_PACKAGES = [
  "electron",
  "framer-motion",
  "zustand",
  "sonner",
  "react-tourlight",
  "katex",
  "monaco-editor",
  "@monaco-editor/react",
  "uuid",
  "clsx",
  "tailwind-merge",
  "@lobehub/icons-static-svg",
];

/**
 * `extends` is only valid at the top level: inside an `overrides` entry oxlint
 * rejects it outright, so the renderer's React layer is spelled out here.
 */
export default defineConfig({
  extends: [base, node],
  ignorePatterns: [
    ...(base.ignorePatterns ?? []),
    "apps/web/src/notchRouteTree.gen.ts",
  ],
  // Repeated at the entry config: `plugins` in an extended config is additive,
  // so without this the unicorn and react-perf correctness rules come back.
  plugins: ["eslint", "typescript", "react"],
  options: { reportUnusedDisableDirectives: "deny" },
  overrides: [
    // The rewrite (spec 01 §3.4): the React Compiler is on, so its rules are
    // errors, and the legacy stack is banned by import.
    {
      files: ["apps/web/src/**/*.{ts,tsx}"],
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
              ...RENDERER_BANNED_PACKAGES.map((name) => ({
                name,
                message: "Not in renderer (spec 01 §3.4).",
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
                  "!#locales/*",
                  "@dicebear/*",
                  "@tsparticles/*",
                  "@radix-ui/*",
                  "@base-ui/react/*",
                ],
                message:
                  "renderer reaches the old tree only through #locales/*; Base UI only inside ui/.",
              },
            ],
          },
        ],
      },
    },
    // Registry output: Base UI is imported here and nowhere else, and the
    // registry may memoise (it is never edited).
    {
      files: ["apps/web/src/ui/**/*.{ts,tsx}"],
      rules: {
        "react/preserve-manual-memoization": "off",
        "no-restricted-imports": [
          "error",
          {
            paths: RENDERER_BANNED_PACKAGES.map((name) => ({
              name,
              message: "Not in renderer (spec 01 §3.4).",
            })),
            patterns: [
              {
                group: ["@dicebear/*", "@tsparticles/*", "@radix-ui/*"],
                message: "renderer does not import the old tree.",
              },
            ],
          },
        ],
      },
    },
    // File routes export `Route`; the router plugin reads them by name, and
    // these are the only files that may default-export at all.
    {
      files: ["apps/web/src/routes/**/*.tsx"],
      rules: { "import/no-default-export": "off" },
    },
  ],
});
