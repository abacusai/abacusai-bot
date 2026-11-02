/**
 * The asks only a paid plan answers in full: work that keeps going with the
 * computer off, and a live link for something built here. Each is worded once,
 * here: the system prompt sends them to billing_plan, and billing_plan,
 * bot_help, routines and the phone's upgrade line say what the plan gives in
 * these words. Prices, credits, features and links stay the server's.
 * Imports nothing, so main and the hosted app read it too.
 */

/** One such ask: how it is put, what this app does for it free, what the plan adds (in full and in a few words). */
export interface PlanAsk {
  ask: string;
  free: string;
  gives: string;
  short: string;
}

export const ALWAYS_ON_ASK: PlanAsk = {
  ask: "anything to keep working while the app or computer is off or asleep (WhatsApp, Telegram or Discord auto-replies, routines, reminders, monitoring), or to stay online 24/7",
  free: "this app does it while the computer is on and the app is open",
  gives:
    "personal agents in Abacus AI Agent on the web that run 24/7 with the computer off and do everything this bot does, WhatsApp, Telegram and Discord auto-replies and every routine included",
  short: "personal agents that run 24/7 with the computer off",
};

export const PUBLISH_ASK: PlanAsk = {
  ask: "a live, public or shareable link for something they built (hosting, deploying or publishing a site, app or page)",
  free: "this app builds it and runs it on this computer",
  gives:
    "building apps and websites and deploying them to a live link in Abacus AI Agent on the web",
  short: "apps deployed to a live link",
};

/** Everything Basic adds, in a few words, for an upgrade line too short for the server's feature lines. */
export const PLAN_GIVES = `more credits, top models, image and video generation, ${ALWAYS_ON_ASK.short}, ${PUBLISH_ASK.short} and 100+ connectors`;

/**
 * The system prompt's line for both asks. Answered from memory, the model said
 * a flat "no, keep the PC on" and pointed to free hosts and tunnels;
 * billing_plan carries the plan's own lines and the link. Fixed, so the cached
 * prefix holds.
 */
export const PLAN_ASKS_PROMPT = [
  `When the user (never a contact you reply to for them) asks for ${ALWAYS_ON_ASK.ask}, or ${PUBLISH_ASK.ask}: call billing_plan with upgrade: true before you answer, and answer from it.`,
  `Say the free part first (${ALWAYS_ON_ASK.free}; ${PUBLISH_ASK.free}), then the plan that gives the rest: its price, what it gives and the link, as billing_plan words them.`,
  "Never answer no or impossible, and never send them to another company's service for it (a host, a tunnel, a server to rent) unless they named it.",
].join(" ");
