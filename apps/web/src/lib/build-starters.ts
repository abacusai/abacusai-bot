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
 * Coding work for an account with GitHub connected: they lead the start page,
 * and the first waits in the box after the first-run GitHub pick. Prompts are
 * localized the same way. i18n: sessions.start.code.<id>.name / .detail / .prompt
 */
export const CODE_STARTER_IDS = [
  "fix-a-bug",
  "add-a-feature",
  "review-my-prs",
] as const;
