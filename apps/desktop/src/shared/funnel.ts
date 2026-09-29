/**
 * First-run milestones the app reports (see main/services/debug-sync/
 * funnel-beacon.ts). A fixed list, so nothing but these names ever leaves the
 * machine, whichever process asks.
 */
export const FUNNEL_STEPS = [
  // Main process.
  "app_opened",
  "signup_clicked",
  "browser_returned",
  "signin_result",
  "first_message",
  // Onboarding screens, in their order.
  "screen_auth",
  "screen_welcome",
  "screen_connectors",
  "screen_models",
  "screen_explainer",
  "onboarding_done",
  "tour_done",
  "tour_skipped",
  // The Chief of Staff popup that follows onboarding.
  "first_bot_shown",
  "first_bot_kept",
  "first_bot_cancelled",
  "first_bot_skipped",
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const isFunnelStep = (value: unknown): value is FunnelStep =>
  FUNNEL_STEPS.includes(value as FunnelStep);

/** A detail is a short code, never free text. */
export const funnelDetail = (value: unknown): string =>
  typeof value === "string"
    ? value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32)
    : "";
