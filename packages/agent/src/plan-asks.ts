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
  ask: "a live link that stays up for a site of several pages or an app that runs a server, built here (hosting, deploying or publishing it)",
  free: "this app builds it and runs it on this computer",
  gives:
    "building apps and websites and deploying them to a live link in Abacus AI Agent on the web",
  short: "apps deployed to a live link",
};

/**
 * An ask for something free or cheaper. Asked for free alternatives with its
 * free credits nearly gone, the model named other AI products, said which was
 * best for coding and packaged the project to move there, and never offered
 * the plan: it goes to billing_plan, whose answer is the plan.
 */
export const CHEAPER_ASK =
  "something free or cheaper (more free credits, a free or cheaper way to keep going, a free alternative to this app)";

/** What no answer about cost does; worded once for the prompt and billing_plan's answer. */
export const NO_OTHER_AI_PRODUCTS =
  "Never recommend other AI products or apps in place of this one, compare them, or help move their work to one (packaging, exporting or migration steps for it), and say nothing against them either; if they still want to leave, say in one line that their files are theirs, in their folder.";

/** Everything Basic adds, in a few words, for an upgrade line too short for the server's feature lines. */
export const PLAN_GIVES = `more credits, top models, image and video generation, ${ALWAYS_ON_ASK.short}, ${PUBLISH_ASK.short} and 100+ connectors`;

/**
 * The system prompt's line for both asks. Answered from memory, the model said
 * a flat "no, keep the PC on" and pointed to free hosts and tunnels;
 * billing_plan carries the plan's own lines and the link. One file needs no
 * plan: sent to billing_plan first, "how can my friend see it?" got Share, a
 * plan check, Share again and a paragraph on hosting. Fixed, so the cached
 * prefix holds.
 */
export const PLAN_ASKS_PROMPT = [
  "When the user asks how someone else can see one page, image, PDF or document made here, that needs no plan: do not call billing_plan. Answer in one or two short lines: press Share, on its row of the files card or at the top of the chat, for a public link anyone can open; a 127.0.0.1 or localhost link opens only on this computer. Share sends that one file, so if the page needs other files of its own (its images), say so in a few words. Bring up a plan only when they ask to keep a site of several pages or an app that runs a server online.",
  `When the user (never a contact you reply to for them) asks for ${ALWAYS_ON_ASK.ask}, or ${PUBLISH_ASK.ask}: call billing_plan with upgrade: true before you answer, and answer from it.`,
  `Say the free part first (${ALWAYS_ON_ASK.free}; ${PUBLISH_ASK.free}), then the plan that gives the rest: its price, every feature it gives as a short list, and the link, as billing_plan words them.`,
  "Never answer no or impossible, and never send them to another company's service for it (a host, a tunnel, a server to rent) unless they named it.",
  `When the user asks for ${CHEAPER_ASK}, or says their credits are low or gone: call billing_plan with upgrade: true before you answer, and answer from it. ${NO_OTHER_AI_PRODUCTS}`,
].join(" ");
