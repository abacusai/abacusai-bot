/**
 * The free grant's milestones on AbacusAI Bot's WhatsApp number: the same
 * words the desktop says once each, with the plan's pitch, the ChatLLM app
 * and the upgrade link, in the language the user hears check-ins in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";
import { describe, expect, it, vi } from "vitest";

import { phoneCreditLine } from "./phone-credit-line";

const BASIC: BillingPlan = {
  current: {
    planName: "Free",
    creditsRemaining: 1_000,
    creditsGranted: 2_000,
    freeTierExpiresAt: null,
  },
  plans: [],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      firstMonthPriceCents: 700,
      priceCents: 1_000,
      percentOff: 30,
      features: ["Top models", "Image and video generation"],
      url: "https://apps.example/bot/link/upgrade?plan=basic",
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

const mark = (reached: 50 | 80): CreditThresholdMark => ({
  reached,
  at: 1,
  used: reached === 50 ? 1_000 : 1_600,
  granted: 2_000,
  perTask: null,
  kind: null,
  told: null,
});

const phoneDir = (language?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-credit-"));
  if (language != null)
    fs.writeFileSync(
      path.join(dir, "checkins.json"),
      JSON.stringify({ language })
    );
  return dir;
};

describe("a credit milestone on WhatsApp", () => {
  it("says half used, the plan's pitch, the ChatLLM app, then the upgrade link last", async () => {
    const say = vi.fn(async (_text: string) => true);
    const went = await phoneCreditLine({
      phoneDir: phoneDir(),
      say,
      billing: async () => BASIC,
    })(mark(50));
    expect(went).toBe(true);
    const text = say.mock.calls[0]![0];
    const lines = text.split("\n");
    expect(lines[0]).toBe("You've used half your free credits");
    expect(text).toContain("You have 1,000 of 2,000 left.");
    expect(text).toContain("- Build and deploy powerful apps on the web");
    expect(text).toContain(
      "Once you upgrade, everything works fully on your phone in the ChatLLM app."
    );
    expect(lines.at(-1)).toBe(
      "Upgrade here: https://apps.example/bot/link/upgrade?plan=basic"
    );
  });

  it("says four fifths in the user's language, and falls back to the bot's page without a plan", async () => {
    const say = vi.fn(async (_text: string) => true);
    await phoneCreditLine({
      phoneDir: phoneDir("es"),
      say,
      billing: async () => null,
    })(mark(80));
    const text = say.mock.calls[0]![0];
    expect(text).toMatch(/400/);
    expect(text).toMatch(/ChatLLM/);
    expect(text).not.toMatch(/Once you upgrade/);
    expect(text).toMatch(/\/bot\/link\/upgrade\?src=whatsapp/);
  });

  it("a paid plan hears the plan the watch stamped, never the free words, and nothing without an offer", async () => {
    const PRO: BillingPlan = {
      ...BASIC,
      current: { ...BASIC.current, plan: "pro", planName: "Pro" },
      upgrades: [
        {
          ...BASIC.upgrades[0]!,
          plan: "max",
          planName: "Max",
          url: "https://apps.example/max",
        },
      ],
      topUpUrl: "https://apps.example/top-up",
    };
    const paidMark = { ...mark(80), plan: "paid" as const };
    const say = vi.fn(async (_text: string) => true);
    expect(
      await phoneCreditLine({
        phoneDir: phoneDir(),
        say,
        billing: async () => PRO,
      })(paidMark)
    ).toBe(true);
    const text = say.mock.calls[0]![0];
    expect(text.split("\n")[0]).toBe("Only 400 credits left this month");
    expect(text).toContain("Add credits here: https://apps.example/top-up");
    expect(text).toContain("https://apps.example/max");
    expect(text).not.toMatch(/free/i);
    // The plan could not be read in time: nothing is said, and it goes again later.
    say.mockClear();
    expect(
      await phoneCreditLine({
        phoneDir: phoneDir(),
        say,
        billing: async () => null,
      })(paidMark)
    ).toBe(false);
    expect(say).not.toHaveBeenCalled();
  });

  it("reports a line that did not go, so the watch does not mark it told", async () => {
    const went = await phoneCreditLine({
      phoneDir: phoneDir(),
      say: async () => false,
      billing: async () => BASIC,
    })(mark(50));
    expect(went).toBe(false);
  });
});
