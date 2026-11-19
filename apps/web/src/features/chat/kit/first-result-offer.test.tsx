import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { FirstResultOfferMark } from "@abacus-ai/contract/first-result-offer";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { closeUpgradeDialog } from "#renderer/lib/upgrade-dialog";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

const ACCOUNT = {
  user_id: "u1",
  organization_id: "o1",
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: null,
  plan: null,
  subscription_tier: "free",
  credits_granted: 2000,
  credits_used: 100,
};

const BILLING: BillingPlan = {
  onboardingOffer: "after_first_result",
  current: {
    plan: "free",
    planName: "Free",
    creditsRemaining: 1900,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/month",
      features: [],
      creditsPerMonth: 20000,
      current: false,
    },
  ],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/month",
      features: [],
      url: "https://apps.abacus.ai/upgrade",
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

const run = (id: string, words: string): StreamChunk[] => [
  b.runStarted(id),
  ...b.text(`${id}-u`, "user", words),
  ...b.text(`${id}-a`, "assistant", "Done."),
  b.runFinished(id, "success"),
];

let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  closeUpgradeDialog();
});

const mount = async (mark: FirstResultOfferMark | null) => {
  const steps: string[] = [];
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const os = implement(contract);
  current = await renderRelay(relay, "session", {}, {}, undefined, {
    system: {
      funnelStep: os.system.funnelStep.handler(({ input }) => {
        steps.push(input.step);
      }),
    },
    account: {
      abacus: os.account.abacus.handler(() => ACCOUNT),
      billingPlan: os.account.billingPlan.handler(() => BILLING),
    },
  });
  await act(async () => {
    await current!.db.updatePrefs({ dismissals: { firstResultOffer: mark } });
  });
  const offer = () =>
    current!.db.collections.prefs.get("app")?.dismissals.firstResultOffer;
  return { relay, steps, offer };
};

const HELD: FirstResultOfferMark = { heldAt: 1, shownOn: null, answered: null };
const findCard = () =>
  screen.findByText("Want more results like this?", undefined, {
    timeout: 5000,
  });
const settled = async () => {
  for (let index = 0; index < 4; index += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
};

describe("FirstResultOfferRow", () => {
  it("shows the held offer under the first finished result, and the other pitches yield", async () => {
    const h = await mount(HELD);
    await act(async () => h.relay.emitAll(run("r1", "Make me a site")));
    const card = await findCard();
    expect(
      card.closest('[data-slot="first-result-offer"]')?.textContent
    ).toContain("Upgrade to Basic");
    await waitFor(() => expect(h.offer()?.shownOn).toBe("r1-a"));
    expect(h.steps).toContain("first_result_offer_shown");
    expect(document.querySelector('[data-slot="top-model-card"]')).toBeNull();
    expect(document.querySelector('[data-slot="success-pitch"]')).toBeNull();
  });

  it("Not now answers it for good", async () => {
    const h = await mount(HELD);
    await act(async () => h.relay.emitAll(run("r1", "Make me a site")));
    fireEvent.click(
      (await findCard())
        .closest('[data-slot="first-result-offer"]')!
        .querySelector("button:last-of-type")!
    );
    await waitFor(() => expect(h.offer()?.answered).toBe("skip"));
    expect(h.steps).toContain("first_result_offer_skip");
    await settled();
    expect(
      document.querySelector('[data-slot="first-result-offer"]')
    ).toBeNull();
  });

  it("passes once the chat moves on to another reply unanswered", async () => {
    const h = await mount(HELD);
    await act(async () => h.relay.emitAll(run("r1", "Make me a site")));
    await findCard();
    await act(async () => h.relay.emitAll(run("r2", "Now add a page")));
    await waitFor(() => expect(h.offer()?.answered).toBe("passed"));
    expect(
      document.querySelector('[data-slot="first-result-offer"]')
    ).toBeNull();
  });

  it("never shows for an account whose offer was not held", async () => {
    const h = await mount(null);
    await act(async () => h.relay.emitAll(run("r1", "Make me a site")));
    await settled();
    expect(
      document.querySelector('[data-slot="first-result-offer"]')
    ).toBeNull();
    expect(h.steps).not.toContain("first_result_offer_shown");
  });
});
