/**
 * Directories no linter or formatter should ever look inside: installed
 * dependencies, build and package output, fetched binaries, and local working
 * state. One list, imported by both the oxlint and oxfmt base configs, so the
 * two tools cannot drift over what counts as generated.
 */
export const BUILD_OUTPUT_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/release/**",
  "**/coverage/**",
  "**/vendor/**",
  "worktrees/**",
  ".claude/**",
];
