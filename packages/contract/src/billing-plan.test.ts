import { describe, expect, it } from "vitest";

import {
  type BillingPlan,
  paidCreditsOffer,
  paidUpgradeOnly,
  PITCH_LINES,
  planPitch,
} from "./billing-plan";

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

  it("measures a paid plan's next plan against its own plan, never the free one", () => {
    const basic = billing(BASIC_FEATURES);
    basic.current = { ...basic.current, plan: "basic", planName: "Basic" };
    basic.plans = [
      { ...basic.plans[1]!, current: true },
      {
        plan: "pro",
        planName: "Pro",
        priceText: "$20/mo",
        features: [],
        creditsPerMonth: 40000,
        current: false,
      },
    ];
    basic.upgrades = [
      {
        plan: "pro",
        planName: "Pro",
        priceText: "$20/mo",
        features: [],
        url: null,
      },
    ];
    expect(planPitch(t, basic, "en-US", ["credits"])).toEqual([
      'outcome.pitch.creditsVsPlan {"credits":"40,000","times":2,"plan":"Basic"}',
    ]);
  });
});

describe("paidCreditsOffer", () => {
  const TOP_UP = "https://example.com/plans?buyCredits=true";
  const tier = (plan: string, planName: string) => ({
    plan,
    planName,
    priceText: "$20/mo",
    features: [`Everything in ${planName}`],
    url: `https://example.com/upgrade/${plan}`,
  });
  const NEXT: Record<string, ReturnType<typeof tier> | undefined> = {
    free: tier("basic", "Basic"),
    go: tier("basic", "Basic"),
    basic: tier("pro", "Pro"),
    pro: tier("max", "Max"),
    max: undefined,
  };
  const plan = (
    current: string | undefined,
    patch: Partial<BillingPlan> = {}
  ): BillingPlan => {
    const next = NEXT[current ?? "basic"];
    return {
      ...billing([]),
      current: {
        ...(current != null && { plan: current }),
        planName: current ?? "Basic",
        creditsRemaining: 0,
        creditsGranted: 20000,
        freeTierExpiresAt: null,
      },
      upgrades: next != null ? [next] : [],
      topUpUrl: TOP_UP,
      upgradeInMobileApp: false,
      ...patch,
    };
  };

  // One row per plan: what every out-of-credits surface offers it.
  it.each([
    [
      "free: the free plan's own dialog, never a paid offer",
      plan("free"),
      null,
    ],
    [
      "an older server that names no plan: the surface keeps what it did",
      plan(undefined),
      null,
    ],
    [
      "basic: the next plan alone, never a top-up",
      plan("basic"),
      { topUpUrl: null, next: NEXT.basic, inMobileApp: false },
    ],
    [
      "pro: top up and the next plan",
      plan("pro"),
      { topUpUrl: TOP_UP, next: NEXT.pro, inMobileApp: false },
    ],
    [
      "max: top up only",
      plan("max"),
      { topUpUrl: TOP_UP, next: null, inMobileApp: false },
    ],
    [
      "go: top up and the next plan the server lists",
      plan("go"),
      { topUpUrl: TOP_UP, next: NEXT.go, inMobileApp: false },
    ],
    [
      "billed by Apple or Google: the mobile app, no links",
      plan("pro", {
        upgradeInMobileApp: true,
        topUpUrl: null,
        upgrades: [{ ...NEXT.pro!, url: null }],
      }),
      { topUpUrl: null, next: { ...NEXT.pro!, url: null }, inMobileApp: true },
    ],
    [
      "basic with no next plan: nothing to offer",
      plan("basic", { upgrades: [] }),
      null,
    ],
    [
      "links that are not https are never opened",
      plan("pro", {
        topUpUrl: "javascript:alert(1)",
        upgrades: [{ ...NEXT.pro!, url: "http://example.com" }],
      }),
      null,
    ],
    ["an unread plan", null, null],
  ])("%s", (_name, billingPlan, expected) => {
    expect(paidCreditsOffer(billingPlan)).toEqual(expected);
  });

  it("only Basic's offer is the next plan alone", () => {
    expect(paidUpgradeOnly(paidCreditsOffer(plan("basic")))).toBe(true);
    for (const current of ["free", "go", "pro", "max"])
      expect(paidUpgradeOnly(paidCreditsOffer(plan(current)))).toBe(false);
    expect(
      paidUpgradeOnly(
        paidCreditsOffer(
          plan("basic", {
            upgradeInMobileApp: true,
            upgrades: [{ ...NEXT.basic!, url: null }],
          })
        )
      )
    ).toBe(false);
  });
});
