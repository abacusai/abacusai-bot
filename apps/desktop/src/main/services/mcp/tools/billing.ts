import {
  type BillingPlan,
  type BillingPlanTier,
  creditsRenewMonthly,
  firstMonthCredits,
} from "@abacus-ai/contract/billing-plan";
import { ABACUS_AGENT_ROUTINES_URL } from "@abacus-ai/contract/routines";

import { cachedAbacusAccount, onFreePlan } from "../../providers/abacus";
import { fetchBillingPlan } from "../../providers/abacus-upgrade";
import type { ToolDefinition, ToolHost, ToolResult } from "./definition";

export const credits = (value: number | null): string =>
  value == null ? "unknown" : Math.round(value).toLocaleString("en-US");

/**
 * "14,000 credits in the first month, then " when a promoted first month
 * grants fewer than the monthly credits, else nothing: what leads every line
 * that states a plan's credits, so a promotion is never read as the monthly figure.
 */
const firstMonthLead = (
  tier: Parameters<typeof firstMonthCredits>[0],
  monthly: number
): string => {
  const first = firstMonthCredits(tier, monthly);
  return first == null
    ? ""
    : `${credits(first)} credits in the first month, then `;
};

/** A plan's credits as the model should say them: "20,000 credits a month", after a promoted first month's. */
export const creditsLine = (
  tier: Parameters<typeof firstMonthCredits>[0],
  monthly: number
): string =>
  `${firstMonthLead(tier, monthly)}${credits(monthly)} credits a month`;

const dollars = (cents: number): string =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

/**
 * The plan's price as the model should say it: a first-month promotion leads
 * with the promo price and says what it is off, so "$7" never reads as $7 every
 * month. Falls back to the server's own price text.
 */
export const priceLine = (tier: BillingPlanTier): string => {
  const { firstMonthPriceCents: first, priceCents: monthly } = tier;
  if (first == null || monthly == null || first >= monthly)
    return tier.priceText;
  const off = tier.percentOff ?? Math.round((1 - first / monthly) * 100);
  return `${dollars(first)} for the first month (${off}% off the usual ${dollars(monthly)}/mo), then ${dollars(monthly)}/mo`;
};

/**
 * A feature that lives in Abacus AI Agent on the web (apps and their monthly
 * project count, 24/7 routines there), as the server words it. Read as a cap
 * on this app's bots, "3 projects a month" lost a sale: the label says where.
 */
const WEB_FEATURE =
  /\bon the web\b|\bAbacus ?AI Agent\b|\bprojects? a month\b/i;

export const bullets = (features: readonly string[]): string[] =>
  features.map((feature) =>
    WEB_FEATURE.test(feature)
      ? `  - ${feature} [in Abacus AI Agent on the web; not a limit on this app]`
      : `  - ${feature}`
  );

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/**
 * Where the user's credits stand, and how to bring them up: as an offer of
 * what the next plan gives, never as a warning. The free credits are a
 * one-time grant and do not renew, said plainly when asked and always with
 * the plan that does. The offer lists the server's features for the plan
 * (models, apps, connectors, routines), so it says what the plan does.
 */
export function creditStanding(billing: BillingPlan): string[] {
  const { current } = billing;
  const next = billing.upgrades[0];
  const left = credits(current.creditsRemaining);
  const granted = credits(current.creditsGranted);
  const standing =
    current.freeTierExpiresAt != null
      ? `Their free credits: ${left} of ${granted} left, usable until ${day(current.freeTierExpiresAt)}.`
      : `Credits left: ${left} of ${granted} this month.`;
  // An upgrade carries its price, features and link; its monthly credits are on the plan list.
  const nextCredits = billing.plans.find(
    (plan) => plan.plan === next?.plan
  )?.creditsPerMonth;
  if (next == null || nextCredits == null) return [standing];
  const where =
    current.freeTierExpiresAt != null
      ? `You have ${left} of your ${granted} free credits, until ${day(current.freeTierExpiresAt)}.`
      : `You have ${left} of your ${granted} credits this month.`;
  return [
    standing,
    `When credits come up, say where they stand, then offer ${next.planName} in their language: its price, everything it gives as a short list, then the link. For example:`,
    `  "${where} ${next.planName} is ${priceLine(next)}, and gives you:`,
    ...next.features.map((feature) => `    - ${feature}`),
    `  <link>"`,
    `Asked whether the free credits refill: they are a one-time grant and do not renew; ${next.planName} gives ${firstMonthLead(next, nextCredits)}a fresh ${credits(nextCredits)} every month. Never say the free credits renew or reset, and never say the app or the agent will stop working.`,
  ];
}

/**
 * What both billing answers state outright so the model never guesses: that
 * the credits renew (and how many), and that this app's bots have no task
 * cap, the web's items being the web's.
 */
export const planFacts = (billing: BillingPlan): string[] => [
  ...(creditsRenewMonthly(billing)
    ? [
        `Their plan's credits renew every month: ${credits(billing.plans.find((plan) => plan.current)?.creditsPerMonth ?? null)} a month. Never call them a one-time grant.`,
      ]
    : []),
  "In this app, bots, chats and routines have no task or project cap: a plan gives them its monthly credits and its models. Items marked as on the web are Abacus AI Agent's, not limits here.",
  "On a plan, creating and editing images, making videos and making speech or audio happen in Abacus AI Agent on the web; this app makes them only with a provider key of the user's own.",
];

/**
 * The answer to "can it keep working with my computer off?": a free account
 * is offered the plan's personal agents on the web, never a flat no; a paid
 * one is pointed at its own.
 */
export const alwaysOnAnswer = (billing: BillingPlan): string =>
  billing.plans.some((plan) => plan.current && plan.plan !== "free")
    ? `Asked for anything to keep working while the app or computer is off (WhatsApp, Telegram or Discord auto-replies, routines, reminders, monitoring) or to stay online 24/7: their plan already includes personal agents in Abacus AI Agent on the web that run 24/7 with the computer off and do everything this bot does there, those auto-replies and every routine included. Set them up there: ${ABACUS_AGENT_ROUTINES_URL} (give the link as written). Do not offer an upgrade for it.`
    : `Asked for anything to keep working while the app or computer is off (WhatsApp, Telegram or Discord auto-replies, routines, reminders, monitoring) or to stay online 24/7: never answer no or impossible. Offer ${billing.upgrades[0]?.planName ?? "the next plan"}: personal agents in Abacus AI Agent on the web that run 24/7 with the computer off and do everything this bot does, WhatsApp, Telegram and Discord auto-replies and every routine included. Use its own feature line above for the wording, with its price and their upgrade link, in their language.`;

/** What the app's model is told about the user's plan, and how to answer. */
export function appBillingResult(
  host: Pick<ToolHost, "ok">,
  billing: BillingPlan | null
): ToolResult {
  if (billing == null)
    return host.ok(
      "The plan details cannot be read right now. Say so plainly in one short line and offer to try again in a moment."
    );
  const lines = [
    `The user's plan: ${billing.current.planName}.`,
    ...creditStanding(billing),
    ...planFacts(billing),
  ];
  lines.push("", "The plans:");
  for (const plan of billing.plans)
    lines.push(
      `${plan.planName}: ${priceLine(plan)}, ${creditsLine(plan, plan.creditsPerMonth)}${plan.current ? " (their plan)" : ""}`,
      ...bullets(plan.features)
    );
  if (billing.upgrades.length > 0) {
    lines.push("", "What they can upgrade to:");
    for (const upgrade of billing.upgrades)
      lines.push(
        `${upgrade.planName}: ${priceLine(upgrade)}${upgrade.url != null ? `, link: ${upgrade.url}` : billing.upgradeInMobileApp ? "" : " (call again with upgrade: true for the link)"}`,
        ...bullets(upgrade.features)
      );
  } else {
    lines.push("", "They are on the top plan: there is nothing to upgrade to.");
  }
  if (billing.topUpUrl != null)
    lines.push(
      "",
      `Buy more credits (when the plan's credits run out early): ${billing.topUpUrl}`
    );
  lines.push(
    "",
    "Answer what they asked, in their language, briefly. When they ask about prices, discounts, upgrading or what a",
    "plan includes, or are short of credits or a limit: lead with the first-month price and what it is off, then every",
    "feature the plan gives, as listed above, as a short list, then the link. On the free plan, offer Basic, and Pro as",
    "the step up with everything it adds on top of Basic. Give each link exactly as written, on its own line. The",
    "features are the server's current list (models included): never add, drop or invent features, prices, discounts or links,",
    "never send them to account settings or a billing page instead of these links, and never say you changed their",
    "plan: they upgrade on the page. Do not bring plans up unasked in the middle of a task or after a complaint."
  );
  lines.push("", alwaysOnAnswer(billing));
  if (billing.upgradeInMobileApp)
    lines.push(
      "Their plan is billed through the app store: they upgrade or buy credits in the mobile app, under Settings. Say so instead of sending a link."
    );
  return host.ok(lines.join("\n"));
}

/** Whether billing_plan is offered: free accounts, or before the first account read. */
export const billingPlanReady = (): boolean => {
  const account = cachedAbacusAccount();
  return account == null || onFreePlan(account);
};

// The server's refusal for a feature its free plan leaves out ("… is available on paid plans",
// "Routines require a paid plan"), whichever tool hit it.
const PAID_PLAN_REFUSAL = /\bpaid plans?\b/i;

/**
 * A tool error, with the plan answer to fetch when it is a paid-plan refusal on a free account,
 * so the user gets the plan, its price and their upgrade link instead of generic steps.
 */
export const withUpgradeNudge = (message: string): string =>
  PAID_PLAN_REFUSAL.test(message) && billingPlanReady()
    ? `${message}\n\n[needs a paid plan] Call billing_plan with upgrade: true, then tell the user once, in their language, that this needs a paid plan, with what the plan gives and their upgrade link. Do not retry this call.`
    : message;

/**
 * The account's plan, prices and upgrade links, for the app's chats and bots
 * (the phone has its own wording, ./phone/billing.ts, over the same call).
 */
export const BILLING_TOOLS: ToolDefinition[] = [
  {
    name: "billing_plan",
    // Every chat, bot and chat app, on every plan and at zero credits: the
    // answer is a read of the account, never something the model recalls.
    toolsets: "always",
    botAlways: true,
    description: [
      "The source of truth for every question about money and limits: the user's Abacus AI plan, credits left and",
      "when they renew, every plan with its price, any first-month discount and what it gives, the limits, and the",
      "links to upgrade or buy credits. Call it for any question, in any wording or language, about what models or",
      "plans cost, prices, discounts or deals, credits or balance, limits, resets or renewals, upgrading, or what a",
      "plan includes; whenever they ask whether anything keeps working while the app or computer is off (WhatsApp,",
      "Telegram or Discord auto-replies, routines, reminders, monitoring, staying online 24/7), which a plan answers",
      "and is never impossible; when they ask to analyse a video (a reel, a Short, a YouTube or TikTok link, a video",
      "file); and when they run into a plan limit or run low on credits. Pass upgrade: true whenever they might",
      "upgrade, so the answer carries their upgrade links.",
      "Never quote a price, discount, credit amount, limit or reset from memory: call this first, every time, and",
      "answer only from what it returns, with every feature line as written (translated, never shortened).",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        upgrade: {
          type: "boolean",
          description:
            "True when they might upgrade: the answer then carries their upgrade links.",
        },
      },
    },
    run: async (host, args) =>
      appBillingResult(host, await fetchBillingPlan(args.upgrade === true)),
  },
];
