import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { PAID_FEATURE_TOOL } from "@abacus-ai/contract/toolsets";

import { fetchBillingPlan } from "../../../providers/abacus-upgrade";
import {
  alwaysOnAnswer,
  bullets,
  creditsLine,
  creditStanding,
  planFacts,
  priceLine,
} from "../billing";
import type { ToolHost, ToolResult } from "../definition";
import type { PhoneToolDefinition } from "./definition";

/** What the phone's model is told about the user's plan, and how to answer. */
export function phoneBillingResult(
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
    "Answer what they asked, in their language, as one short WhatsApp message. When they ask about upgrading, or",
    "are short of credits or a limit: pitch the upgrades above with every feature line as written (translated, never",
    "shortened or dropped), then the link.",
    "On the free plan, offer both: Basic, and Pro as the even better choice, saying what Pro adds on top of Basic.",
    "Give each link exactly as written, on its own line. Never invent features, prices or links, and never send them",
    "to account settings or a billing page instead of these links. Never say you changed their plan: they upgrade",
    "on the page."
  );
  lines.push("", alwaysOnAnswer(billing));
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
      "credits. Call it whenever they ask about their plan, credits or balance, prices or discounts, limits or",
      "resets, upgrading, or what a plan includes; whenever they ask whether something keeps working while their",
      "app or computer is off (WhatsApp, Telegram or Discord auto-replies, routines, reminders); and when they run",
      `into a plan limit or run low on credits. Never answer these from memory. A video to watch is ${PAID_FEATURE_TOOL}'s.`,
      "It answers at once; send them what it says, with every feature line as written and its links as given. Pass",
      "upgrade: true whenever they might upgrade (they ask about upgrading or prices, or hit a limit or run low), so",
      "the answer carries their upgrade links.",
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
