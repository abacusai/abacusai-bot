import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import type {
  SuccessPitchCard,
  SuccessPitchOffer,
} from "@abacus-ai/contract/success-pitch";
import { implement } from "@orpc/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DbProvider } from "#renderer/data/db";
import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import {
  closeUpgradeDialog,
  requestPlanDialog,
  upgradeDialogStore,
} from "#renderer/lib/upgrade-dialog";
import { createHarness, defaultSeed } from "#renderer/test-support/app-harness";

import { ChatViewProvider, type ChatViewContextValue } from "./context";
import { SuccessPitchRow } from "./success-pitch";

const BILLING: BillingPlan = {
  current: {
    planName: "Free",
    creditsRemaining: 1800,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [],
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
      features: [
        "Top models including Model A, Model B, Model C, Model D and Model E",
      ],
      url: null,
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

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
  credits_used: 200,
};

const OFFER: SuccessPitchOffer = {
  id: "turn-1",
  sessionId: "thread-1",
  trigger: "deliverable",
  moment: "site",
  lead: "apps",
  at: 1,
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  closeUpgradeDialog();
});

const mount = async ({
  account = ACCOUNT as typeof ACCOUNT | null,
  billing = BILLING as BillingPlan | null,
  offer = OFFER as SuccessPitchOffer | null,
  card = undefined as SuccessPitchCard | undefined,
  prefs = {} as Partial<PrefsRow>,
  threadId = "thread-1",
  active = false,
  readOnly = false,
} = {}) => {
  const os = implement(contract);
  const seed = defaultSeed();
  const base = fixturePrefs();
  const opened: string[] = [];
  const harness = await createHarness("/", {
    seed: {
      ...seed,
      prefs: fixturePrefs({
        successPitch: {
          "o1:u1": { offer, appTurns: 1, chatTurns: 0, chatToldAt: null },
        },
        dismissals: {
          ...base.dismissals,
          ...(card != null ? { successPitchCards: { "o1:u1": card } } : {}),
        },
        ...prefs,
      }),
    },
    openExternal: (url) => opened.push(url),
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => account),
        billingPlan: os.account.billingPlan.handler(() => billing),
        payment: os.account.payment.handler(() => null),
      },
    },
  });
  const chat = {
    threadId,
    session: { threadId },
    composer: readOnly ? { readOnly: { reason: "routine" } } : {},
    slots: {},
  } as unknown as ChatViewContextValue;
  const queryClient = harness.router.options.context.queryClient;
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={harness.appDb}>
            <ChatViewProvider value={chat}>
              <SuccessPitchRow active={active} />
            </ChatViewProvider>
          </DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  });
  cleanup = async () => {
    rendered.unmount();
    await harness.cleanup();
  };
  const steps = () =>
    harness.calls
      .filter(([name]) => name === "system.funnelStep")
      .map(([, input]) => input as { step: string; detail?: string });
  const cards = () =>
    harness.appDb.collections.prefs.get("app")?.dismissals.successPitchCards;
  return { harness, steps, cards, opened };
};

const card = (patch: Partial<SuccessPitchCard> = {}): SuccessPitchCard => ({
  shown: 0,
  lastShownAt: null,
  notNow: 0,
  shownOffer: null,
  answered: null,
  ...patch,
});

/** Lets every query settle, so a card that is coming has come. */
const settled = async () => {
  for (let index = 0; index < 5; index += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
};

describe("SuccessPitchRow", () => {
  it("shows the result, the price and the plan's whole pitch led by apps after a site", async () => {
    const h = await mount();
    const pitch = await screen.findByText("Your site is up and running.");
    const box = pitch.closest('[data-slot="success-pitch"]')!;
    expect(box.textContent).toContain(
      "Keep projects like this going with Basic."
    );
    expect(box.textContent).toContain("$7 your first month, then $10/month");
    expect(
      [...box.querySelectorAll('[data-slot="upgrade-pitch"] li')].map(
        (item) => item.textContent
      )
    ).toEqual([
      "Build and deploy powerful apps on the web, including mobile apps",
      "Top models: Model A, Model B, Model C, Model D",
      "Image and video generation",
      "20,000 credits a month (10x the free plan)",
      "Personal agents in Abacus AI Agent on the web that run 24/7, even with your computer off: WhatsApp, Discord and Telegram auto-replies, all your routines, and everything your bot does",
      "100+ connectors: Gmail, Google Calendar, Slack, Drive, Notion and more",
    ]);
    expect(
      screen.getByRole("button", { name: "Upgrade to Basic" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(h.steps()).toEqual([
        { step: "success_pitch_shown", detail: "deliverable" },
      ])
    );
    await waitFor(() =>
      expect(h.cards()?.["o1:u1"]).toMatchObject({
        shown: 1,
        shownOffer: "turn-1",
        answered: null,
      })
    );
  });

  it("words each moment and leads the list with it", async () => {
    await mount({
      offer: {
        ...OFFER,
        trigger: "positive_reaction",
        moment: "reaction",
        lead: "agents",
      },
    });
    const pitch = await screen.findByText("Glad that worked for you.");
    expect(
      pitch
        .closest('[data-slot="success-pitch"]')!
        .querySelector('[data-slot="upgrade-pitch"] li')?.textContent
    ).toMatch(/^Personal agents/);
  });

  it("Upgrade opens checkout through the upgrade dialog, waiting for the plan", async () => {
    const h = await mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upgrade to Basic" })
    );
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "plan",
      checkout: true,
    });
    // Checkout opened in the browser, as the dialog's own Upgrade does.
    await waitFor(() => expect(h.opened).toHaveLength(1));
    await waitFor(() =>
      expect(h.cards()?.["o1:u1"]).toMatchObject({
        answered: "turn-1",
        notNow: 0,
      })
    );
    expect(h.steps().map((step) => step.step)).toContain(
      "success_pitch_upgrade"
    );
  });

  it("Not now hides it and counts toward the two that end it", async () => {
    const h = await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(h.cards()?.["o1:u1"]).toMatchObject({
        notNow: 1,
        answered: "turn-1",
      })
    );
    await waitFor(() =>
      expect(document.querySelector('[data-slot="success-pitch"]')).toBeNull()
    );
    expect(h.steps().map((step) => step.step)).toEqual([
      "success_pitch_shown",
      "success_pitch_not_now",
    ]);
  });

  it("never in another chat, mid-turn, read-only, or once answered", async () => {
    for (const options of [
      { threadId: "thread-2" },
      { active: true },
      { readOnly: true },
      { card: card({ answered: "turn-1", shown: 1, lastShownAt: 0 }) },
    ]) {
      const h = await mount(options);
      await settled();
      expect(document.querySelector('[data-slot="success-pitch"]')).toBeNull();
      expect(h.steps()).toEqual([]);
      await cleanup?.();
      cleanup = undefined;
    }
  });

  it("never past the caps, but a card already shown stays until answered", async () => {
    for (const capped of [
      card({ shown: 3, lastShownAt: 0 }),
      card({ shown: 1, lastShownAt: Date.now() - 60_000 }),
      card({ shown: 2, notNow: 2, lastShownAt: 0 }),
    ]) {
      await mount({ card: capped });
      await settled();
      expect(document.querySelector('[data-slot="success-pitch"]')).toBeNull();
      await cleanup?.();
      cleanup = undefined;
    }
    await mount({
      card: card({
        shown: 1,
        lastShownAt: Date.now() - 60_000,
        shownOffer: "turn-1",
      }),
    });
    expect(
      await screen.findByText("Your site is up and running.")
    ).toBeTruthy();
  });

  it("never for a paid plan, past half the free credits, without the plan, or over another card", async () => {
    for (const options of [
      { account: { ...ACCOUNT, subscription_tier: "basic" } },
      { account: { ...ACCOUNT, credits_used: 1000 } },
      { billing: null },
      {
        prefs: {
          creditThresholds: {
            "o1:u1": {
              reached: 50 as const,
              at: 1,
              used: 1000,
              granted: 2000,
              perTask: null,
              kind: null,
              told: null,
            },
          },
        },
      },
    ]) {
      await mount(options);
      await settled();
      expect(document.querySelector('[data-slot="success-pitch"]')).toBeNull();
      await cleanup?.();
      cleanup = undefined;
    }
    requestPlanDialog("model_locked");
    await mount();
    await settled();
    expect(document.querySelector('[data-slot="success-pitch"]')).toBeNull();
  });
});
