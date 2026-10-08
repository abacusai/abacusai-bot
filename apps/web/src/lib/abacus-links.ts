/**
 * Abacus.AI account pages the app opens (copied from the old renderer's
 * `lib/abacus-credits.ts`, which renderer may not import).
 */

/** Where Upgrade goes without an upgrade page of its own: the product page, before a plan picker. */
export const ABACUS_PLAN_URL = "https://agent.abacus.ai/";

/** Where a Pro account tops up, rather than the plan chooser it has used. */
export const ABACUS_BUY_CREDITS_URL =
  "https://apps.abacus.ai/chatllm/admin/profile?buyCredits=true";

/** Where the desktop app is downloaded: where a web user out of time is sent. */
export const DESKTOP_DOWNLOAD_URL = "https://bot.abacus.ai";

export const ABACUS_AGENT_URL = "https://apps.abacus.ai/chatllm";
export const ABACUS_TERMS_URL = "https://abacus.ai/terms";
export const ABACUS_HELP_URL =
  "https://github.com/abacusai/abacusai-bot/blob/main/README.md";
