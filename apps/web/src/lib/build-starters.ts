/**
 * The first-run screen's build examples, and the start page's suggestions
 * after it. Their prompts are localized: a tap sends one as the user's own
 * words. i18n: sessions.start.build.<id>.name / .detail / .prompt
 */
export const BUILD_STARTER_IDS = [
  "portfolio-site",
  "shop-page",
  "simple-game",
] as const;

export const GITHUB_CONNECTOR_ID = "abacus-githubbot";

/**
 * Coding work for an account with GitHub connected: they lead the start page.
 * Prompts are localized the same way. i18n: sessions.start.code.<id>.name / .detail / .prompt
 */
export const CODE_STARTER_IDS = [
  "fix-a-bug",
  "add-a-feature",
  "review-my-prs",
] as const;

/**
 * The first-run GitHub pick's task, sent at once: one that does real work
 * before asking anything (the others start by asking what to fix or add).
 */
export const GITHUB_FIRST_TASK: (typeof CODE_STARTER_IDS)[number] =
  "review-my-prs";
