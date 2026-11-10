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
  "first_choice_github",
  "first_choice_research",
  "first_choice_images",
  "first_choice_freetext",
  "screen_b_shown",
  // A bot the user made: the detail is its template, own_words for a bot made
  // from their own words, or custom.
  "bot_created",
  // A Connect card shown in a chat, and an account connected; the detail is
  // the connector.
  "connect_card_shown",
  "connect_done",
  // A bot asked to build offers a session (offer_session's card).
  "session_offer_shown",
  "session_offer_opened",
  // A coding starter on the session start page; the detail is which.
  "code_starter_tapped",
  // The session start page, once per draft: shown (detail: its starters and
  // whether an example waits in the box), another starter tapped (which), the
  // box first edited, and what was sent (example, starter, edited or own).
  "start_page_shown",
  "start_starter_tapped",
  "start_prompt_edited",
  "start_sent",
  // A bot's reply ended with tap-to-run tasks (suggest_tasks); the detail is
  // the bot's template, and a tap's also whether it copied.
  "task_suggestions_shown",
  "task_suggestion_tapped",
  // The next step (next-step.ts). The install's half, once (on or off); a
  // result handed over, by what it was and the half; then the offer under it,
  // and a tap, as work or routine.
  "next_step_half",
  "result_delivered",
  "next_step_shown",
  "next_step_tapped",
  // The retry on a top model (retry-offer.ts). The account's half, once (on
  // or off); the line, by why it showed; a tap and a close.
  "retry_offer_half",
  "retry_offer_shown",
  "retry_offer_tapped",
  "retry_offer_dismissed",
  // The agent asked for a routine that already exists, and got that one back;
  // the detail is how it compared (same, alike or check-in) and where it lives.
  "routine_duplicate_avoided",
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
  // A paid plan's credit milestone card: its top-up, its next plan, or keep going.
  "credit_card_paid_50_shown",
  "credit_card_paid_50_top_up",
  "credit_card_paid_50_next_plan",
  "credit_card_paid_50_continue",
  "credit_card_paid_80_shown",
  "credit_card_paid_80_top_up",
  "credit_card_paid_80_next_plan",
  "credit_card_paid_80_continue",
  // A free account's success pitch (success-pitch.ts); the detail is its trigger.
  "success_pitch_shown",
  "success_pitch_upgrade",
  "success_pitch_not_now",
  "success_pitch_withdrawn",
  "success_pitch_chat_told",
  // The offer to turn a long answer into a document (deliverable-offer.ts);
  // the detail is the button (doc or report) and the chat's skin.
  "deliverable_offer_shown",
  "deliverable_offer_clicked",
  "deliverable_offer_dismissed",
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
  // The credits line under a finished turn, clicked; the detail is the plan tier.
  "turn_credits_clicked",
  // A reply ended on a promise of more work and the model was told to do it
  // (promised-work.ts); the detail is the model.
  "promised_work_recovery",
  // The Basic offer at the end of onboarding (the platform's onboarding offer).
  "onboarding_offer_shown",
  "onboarding_offer_upgrade",
  "onboarding_offer_skip",
  // The welcome right after a payment lands; shown's detail is the tier and
  // whether a paused turn waits, the unlock's is what it opens.
  "paid_welcome_shown",
  "paid_welcome_resume",
  "paid_welcome_routines",
  "paid_welcome_unlock",
  "paid_welcome_closed",
  // A paid plan's deploy steps for a site the agent built; the detail is
  // where they showed (welcome or card).
  "site_deploy_shown",
  "site_deploy_open_agent",
  "site_deploy_pack",
  "site_deploy_show_folder",
  "site_deploy_drag",
  "site_deploy_copy",
  "site_deploy_cancel",
  "site_deploy_retry",
  "site_deploy_dismissed",
  // A public link to a file the bot made (share.ts); share_failed's detail is
  // the refusal.
  "share_opened",
  "share_created",
  "share_copied",
  "share_link_opened",
  "share_unshared",
  "share_failed",
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const isFunnelStep = (value: unknown): value is FunnelStep =>
  FUNNEL_STEPS.includes(value as FunnelStep);

/** The onboarding offer's steps the account records as well, by the platform's names for them. */
export const ONBOARDING_OFFER_ACCOUNT_STEPS = {
  onboarding_offer_shown: "shown",
  onboarding_offer_upgrade: "upgrade",
  onboarding_offer_skip: "skip",
} as const satisfies Partial<Record<FunnelStep, string>>;

export type OnboardingOfferAccountStep =
  (typeof ONBOARDING_OFFER_ACCOUNT_STEPS)[keyof typeof ONBOARDING_OFFER_ACCOUNT_STEPS];

export const onboardingOfferAccountStep = (
  step: FunnelStep
): OnboardingOfferAccountStep | null =>
  step in ONBOARDING_OFFER_ACCOUNT_STEPS
    ? ONBOARDING_OFFER_ACCOUNT_STEPS[
        step as keyof typeof ONBOARDING_OFFER_ACCOUNT_STEPS
      ]
    : null;

/** A detail is a short code, never free text. */
/** A template or connector id as a detail: "abacus-gmailuser" is gmailuser, "personal-admin" personal_admin. */
export const funnelId = (id: string): string =>
  id.replace(/^abacus-/, "").replace(/-/g, "_");

export const funnelDetail = (value: unknown): string =>
  typeof value === "string"
    ? value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32)
    : "";
