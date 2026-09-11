import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

import { BUILD_OUTPUT_IGNORES } from "../build-output-ignores.ts";

export default defineConfig({
  ...ultracite,
  // ultracite's style, untouched. The additions are files another tool writes,
  // which a formatter would churn against on every run.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ...BUILD_OUTPUT_IGNORES,
    // Prose. Reflowing turns a one-word fix into a paragraph diff, and the
    // bundled skills are what the model reads.
    "**/*.md",
    // Written by sync-locales.js and check-jsx-i18n.js --update.
    "**/locales/**",
    "**/i18n-literals-baseline.json",
    // Written by the package manager.
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    // Mostly Tailwind `prose` output, and oxfmt breaks long selectors across
    // lines, which the agent's symbol indexer records the wrong line for.
    "**/*.css",
    // Shipped as-is: templates, icons, media.
    "apps/desktop/resources/**",
    "apps/desktop/build/**",
    "docs/media/**",
  ],
});
