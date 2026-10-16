import { cachedAbacusAccount, onFreePlan } from "../../providers/abacus";
import {
  type BillingPlan,
  type BillingPlanTier,
  fetchBillingPlan,
} from "../../providers/abacus-upgrade";
import type { ToolDefinition, ToolHost, ToolResult } from "./definition";

export const credits = (value: number | null): string =>
  value == null ? "unknown" : Math.round(value).toLocaleString("en-US");

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

export const bullets = (features: readonly string[]): string[] =>
  features.map((feature) => `  - ${feature}`);

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/**
 * Where the user's credits stand, and how to bring them up: as an offer of
 * what the next plan gives, never as a warning. A free account read the old
 * "a one-time grant that does not renew" as the end of the product and left
 * with every credit unused. The offer lists the server's features for the
 * plan (models, apps, connectors, routines), so it says what the plan does.
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
    `Asked whether the free credits refill: ${next.planName} gives a fresh ${credits(nextCredits)} every month. Never call the free credits a one-time grant or say they do not renew, and never say the app or the agent will stop working.`,
  ];
}

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
  ];
  lines.push("", "The plans:");
  for (const plan of billing.plans)
    lines.push(
      `${plan.planName}: ${priceLine(plan)}, ${credits(plan.creditsPerMonth)} credits a month${plan.current ? " (their plan)" : ""}`,
      ...bullets(plan.features)
    );
  if (billing.upgrades.length > 0) {
    lines.push("", "What they can upgrade to:");
    for (const upgrade of billing.upgrades)
      lines.push(
        `${upgrade.planName}: ${priceLine(upgrade)}${upgrade.url != null ? `, link: ${upgrade.url}` : ""}`,
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
    ? `${message}\n\n[needs a paid plan] Call billing_plan, then tell the user once, in their language, that this needs a paid plan, with what the plan gives and their upgrade link. Do not retry this call.`
    : message;

/**
 * The account's plan, prices and upgrade links, for the app's chats and bots
 * (the phone has its own wording, ./phone/billing.ts, over the same call).
 */
export const BILLING_TOOLS: ToolDefinition[] = [
  {
    name: "billing_plan",
    toolsets: "always",
    botAlways: true,
    // Free accounts only: a paid account the app has read is never offered it.
    // Before the first account read it is listed, and its answer still fits.
    ready: billingPlanReady,
    description: [
      "The user's Abacus AI plan and credits, every plan with its price, any first-month discount and what it gives,",
      "and the links to upgrade or buy credits. Call it whenever they ask about their plan, credits or balance, prices,",
      "discounts or deals, upgrading, or what a plan includes, and when they run into a plan limit or run low on",
      "credits.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
    run: async (host) =>
      appBillingResult(host, await fetchBillingPlan("billing_plan")),
  },
];
