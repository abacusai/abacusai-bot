import { describe, expect, it } from "vitest";

import { type BillingPlan, PITCH_LINES, planPitch } from "./billing-plan";

/** The Basic tier's feature lines, worded as the billing plan sends them. */
const BASIC_FEATURES = [
  "Top models including Model A, Model B, Model C, Model D and Model E",
  "Build and deploy powerful apps on the web, including mobile apps: 3 projects a month",
  "Personal agents in Abacus AI Agent on the web that run 24/7, even with your computer off: WhatsApp, Discord and Telegram auto-replies, all your routines, and everything your bot does",
  "Image and video generation",
  "Unlimited chatting with the bot (20,000 credits a month)",
  "100+ connectors: Gmail, Google Calendar, Slack, Drive, Notion and more",
];

const billing = (features: string[]): BillingPlan => ({
  current: {
    planName: "Free",
    creditsRemaining: 2000,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "free",
      planName: "Free",
      priceText: "$0",
      features: [],
      creditsPerMonth: 2000,
      current: true,
    },
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features,
      creditsPerMonth: 20000,
      current: false,
    },
  ],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features,
      url: null,
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
});

/** Echoes the key and its values, so the test reads what was asked for. */
const t = (key: string, values?: Record<string, string | number>) =>
  values == null ? key : `${key} ${JSON.stringify(values)}`;

describe("planPitch", () => {
  it("lists every line of the plan, the apps line with the plan's projects a month", () => {
    expect(planPitch(t, billing(BASIC_FEATURES), "en-US")).toEqual([
      'outcome.pitch.credits {"credits":"20,000","times":10}',
      'outcome.pitch.models {"models":"Model A, Model B, Model C, Model D"}',
      "outcome.pitch.media",
      "outcome.pitch.agents",
      "outcome.pitch.connectors",
      'outcome.pitch.appsProjects {"count":3}',
    ]);
  });

  it("keeps the apps line without a count when the plan names none", () => {
    const lines = planPitch(
      t,
      billing(
        BASIC_FEATURES.map((line) =>
          line.startsWith("Build and deploy")
            ? "Build and deploy powerful apps on the web"
            : line
        )
      ),
      "en-US"
    );
    expect(lines).toHaveLength(PITCH_LINES.length);
    expect(lines.at(-1)).toBe("outcome.pitch.apps");
  });

  it("reads the count from the plan, not from the app", () => {
    const lines = planPitch(
      t,
      billing(
        BASIC_FEATURES.map((line) =>
          line.endsWith("3 projects a month")
            ? line.replace("3 projects", "5 projects")
            : line
        )
      ),
      "en-US",
      ["apps"]
    );
    expect(lines).toEqual(['outcome.pitch.appsProjects {"count":5}']);
  });

  it("leads with a promoted first month's credits, and keeps the monthly line without one", () => {
    const promoted = billing(BASIC_FEATURES);
    promoted.upgrades[0]!.firstMonthCredits = 14000;
    expect(planPitch(t, promoted, "en-US", ["credits"])).toEqual([
      'outcome.pitch.introCredits {"credits":"20,000","times":10,"first":"14,000"}',
    ]);
    const unpromoted = billing(BASIC_FEATURES);
    unpromoted.upgrades[0]!.firstMonthCredits = 20000;
    expect(planPitch(t, unpromoted, "en-US", ["credits"])).toEqual([
      'outcome.pitch.credits {"credits":"20,000","times":10}',
    ]);
  });
});
