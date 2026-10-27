/**
 * First-run milestones the app reports (see main/services/debug-sync/
 * funnel-beacon.ts). A fixed list, so nothing but these names ever leaves the
 * machine, whichever process asks.
 */
export const FUNNEL_STEPS = [
  // Main process.
  "app_opened",
  "auto_signin",
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
  // The first-bot screen's other choice: straight to a session to build.
  "first_build_chosen",
  // The first-run screen: the card picked, and the inbox result after a Gmail sign-in.
  "first_choice_build",
  "first_choice_whatsapp",
  "first_choice_research",
  "first_choice_images",
  "first_choice_freetext",
  "screen_b_shown",
  // A bot asked to build offers a session (offer_session's card).
  "session_offer_shown",
  "session_offer_opened",
  // A bot's reply ended with tap-to-run tasks (suggest_tasks); the detail is
  // the bot's template, and a tap's also whether it copied.
  "task_suggestions_shown",
  "task_suggestion_tapped",
  // A free account's chat on another provider's model: the RouteLLM notice.
  "routellm_nudge_shown",
  "routellm_nudge_switched",
  "routellm_nudge_kept",
  // A free account's credit milestone card (credit-thresholds.ts).
  "credit_card_50_shown",
  "credit_card_50_upgrade",
  "credit_card_50_continue",
  "credit_card_80_shown",
  "credit_card_80_upgrade",
  "credit_card_80_continue",
  // A free account's success pitch (success-pitch.ts); the detail is its trigger.
  "success_pitch_shown",
  "success_pitch_upgrade",
  "success_pitch_not_now",
  "success_pitch_withdrawn",
  "success_pitch_chat_told",
  // Google cut a reply off on a model the user picked (the cut-off card);
  // the card's detail is its state: credits, out, held or paid.
  "cutoff_card_shown",
  "cutoff_continue",
  "cutoff_switch_routellm",
  "cutoff_upgrade",
  "cutoff_upgraded",
  "cutoff_verify",
  // The same, in the user's own chat app; the detail is the platform.
  "cutoff_chat_told",
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const isFunnelStep = (value: unknown): value is FunnelStep =>
  FUNNEL_STEPS.includes(value as FunnelStep);

/** A detail is a short code, never free text. */
export const funnelDetail = (value: unknown): string =>
  typeof value === "string"
    ? value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32)
    : "";
