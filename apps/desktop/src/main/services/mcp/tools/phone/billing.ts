import {
  type BillingPlan,
  fetchBillingPlan,
} from "../../../providers/abacus-upgrade";
import type { ToolHost, ToolResult } from "../definition";
import type { PhoneToolDefinition } from "./definition";

const credits = (value: number | null): string =>
  value == null ? "unknown" : Math.round(value).toLocaleString("en-US");

const bullets = (features: readonly string[]): string[] =>
  features.map((feature) => `  - ${feature}`);

/** What the phone's model is told about the user's plan, and how to answer. */
export function phoneBillingResult(
  host: Pick<ToolHost, "ok">,
  billing: BillingPlan | null
): ToolResult {
  if (billing == null)
    return host.ok(
      "The plan details cannot be read right now. Say so plainly in one short line and offer to try again in a moment."
    );
  const { current } = billing;
  const lines = [
    `The user's plan: ${current.planName}.`,
    `Credits left: ${credits(current.creditsRemaining)} of ${credits(current.creditsGranted)} this period.`,
  ];
  if (current.freeTierExpiresAt != null)
    lines.push(`Free credits end: ${current.freeTierExpiresAt}.`);
  lines.push("", "The plans:");
  for (const plan of billing.plans)
    lines.push(
      `${plan.planName}: ${plan.priceText}, ${credits(plan.creditsPerMonth)} credits a month${plan.current ? " (their plan)" : ""}`,
      ...bullets(plan.features)
    );
  if (billing.upgrades.length > 0) {
    lines.push("", "What they can upgrade to:");
    for (const upgrade of billing.upgrades)
      lines.push(
        `${upgrade.planName}: ${upgrade.priceText}${upgrade.url != null ? `, link: ${upgrade.url}` : billing.upgradeInMobileApp ? "" : " (call again with upgrade: true for the link)"}`,
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
    "Answer what they asked, in their language, as one short WhatsApp message. When they ask about upgrading, or",
    "are short of credits or a limit: pitch the upgrades above as a short list of what each gives, then the link.",
    "On the free plan, offer both: Basic, and Pro as the even better choice, saying what Pro adds on top of Basic.",
    "Give each link exactly as written, on its own line. Never invent features, prices or links, and never send them",
    "to account settings or a billing page instead of these links. Never say you changed their plan: they upgrade",
    "on the page."
  );
  if (billing.upgradeInMobileApp)
    lines.push(
      "Their plan is billed through the app store: they upgrade or buy credits in the mobile app, under Settings. Say so instead of sending a link."
    );
  return host.ok(lines.join("\n"));
}

export const PHONE_BILLING_TOOLS: PhoneToolDefinition[] = [
  {
    surface: "phone",
    name: "billing_plan",
    toolsets: "always",
    description: [
      "The user's plan and credits, every plan with its price and what it gives, and the links to upgrade or buy",
      "credits. Call it whenever they ask about their plan, credits or balance, prices, upgrading, or what a plan",
      "includes, and when they run into a plan limit or run low on credits. It answers at once; send them what it",
      "says, with its links as given. Pass upgrade: true whenever they might upgrade (they ask about upgrading or",
      "prices, or hit a limit or run low), so the answer carries their upgrade links.",
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
      phoneBillingResult(host, await fetchBillingPlan(args.upgrade === true)),
  },
];
