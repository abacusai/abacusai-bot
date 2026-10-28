import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";
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
import { afterEach, describe, expect, it, vi } from "vitest";

import { DbProvider } from "#renderer/data/db";
import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import {
  closeUpgradeDialog,
  requestUpgradeDialog,
  type UpgradeDialogRequest,
} from "#renderer/lib/upgrade-dialog";
import { createHarness, defaultSeed } from "#renderer/test-support/app-harness";

import { renderWithDb } from "../../features/chat/testing";
import { UpgradeDialogHost } from "../../features/upgrade-dialog";
import { DeliverablesCard } from "../file-preview";
import { CreditsCard, missingFreeSources } from "./index";
import { CutOffCard } from "./model-unavailable";
import { CreditThresholdCard, CreditThresholdHost } from "./threshold";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it("offers the next two missing sources in the pool's spending order", () => {
  expect(missingFreeSources({})).toEqual(["gemini", "openrouter"]);
  expect(missingFreeSources({ gemini: true, openrouter: true })).toEqual([
    "mistral",
    "nvidia",
  ]);
  expect(
    missingFreeSources({
      gemini: true,
      openrouter: true,
      mistral: true,
      nvidia: true,
    })
  ).toEqual(["cerebras", "groq"]);
});

it("connects OpenRouter and replays a dead turn once after the refreshed catalog", async () => {
  const onResume = vi.fn(async () => {});
  const configured = { gemini: true };
  const connectFreeSource = vi.fn(async () => {
    Object.assign(configured, { openrouter: true });
    return true;
  });
  const rendered = await renderWithDb(
    <CreditsCard
      tier="free"
      host={{
        openExternal: async () => {},
        openUpgrade: async () => {},
        configuredFreeSources: async () => configured,
        connectFreeSource,
      }}
      onResume={onResume}
    />
  );
  cleanup = rendered.cleanup;
  await waitFor(() =>
    expect(document.querySelector('[data-source="openrouter"]')).toBeTruthy()
  );
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(
      '[data-source="openrouter"] button'
    )!
  );
  await waitFor(() => expect(onResume).toHaveBeenCalledOnce());
  expect(connectFreeSource).toHaveBeenCalledExactlyOnceWith(
    "openrouter",
    undefined
  );
});

it("a paid plan the server does not name (an older server) keeps its Top up, on the top-up link", async () => {
  const openExternal = vi.fn(async () => {});
  const openUpgrade = vi.fn(async () => {});
  const openTopUp = vi.fn(async () => {});
  const rendered = await renderWithDb(
    <CreditsCard
      tier="basic"
      host={{
        openExternal,
        openUpgrade,
        openTopUp,
        canTopUpCredits: async () => true,
      }}
    />
  );
  cleanup = rendered.cleanup;
  expect(document.querySelector("[data-source]")).toBeNull();
  fireEvent.click(await screen.findByRole("button"));
  expect(openTopUp).toHaveBeenCalledOnce();
  expect(openUpgrade).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  "does not infer a paid top-up offer without billing eligibility (%s)",
  async (eligible) => {
    const rendered = await renderWithDb(
      <CreditsCard
        tier="paid"
        host={{
          openExternal: async () => {},
          openUpgrade: async () => {},
          ...(eligible === undefined
            ? {}
            : { canTopUpCredits: async () => eligible }),
        }}
      />
    );
    cleanup = rendered.cleanup;
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Top up" })).toBeNull()
    );
  }
);

it("offers upgrade for an exhausted free account while retaining free sources", async () => {
  const openUpgrade = vi.fn(async () => {});
  const rendered = await renderWithDb(
    <CreditsCard
      tier="free"
      host={{
        openExternal: async () => {},
        openUpgrade,
        configuredFreeSources: async () => ({}),
      }}
    />
  );
  cleanup = rendered.cleanup;
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  expect(openUpgrade).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(document.querySelector('[data-source="gemini"]')).toBeTruthy()
  );
});

it("does not infer an upgrade offer for an unknown account", async () => {
  const rendered = await renderWithDb(
    <CreditsCard
      tier="unknown"
      host={{ openExternal: async () => {}, openUpgrade: async () => {} }}
    />
  );
  cleanup = rendered.cleanup;
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
});

it("lists what the cut-off turn already handed over, each one openable", async () => {
  const onOpen = vi.fn();
  const rendered = await renderWithDb(
    <CreditsCard
      tier="free"
      host={{ openExternal: async () => {}, openUpgrade: async () => {} }}
      ready={
        <DeliverablesCard
          items={[
            { path: "/w/site/index.html", label: "Landing page", isUrl: false },
            { path: "http://localhost:5173", isUrl: true },
          ]}
          onOpen={onOpen}
          onOpenUrl={() => {}}
        />
      }
    />
  );
  cleanup = rendered.cleanup;
  const ready = document.querySelector('[data-slot="credits-ready"]')!;
  expect(ready.textContent).toContain("What's ready");
  fireEvent.click(screen.getByText("Landing page"));
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/w/site/index.html" })
  );
  expect(screen.getByText("http://localhost:5173")).toBeTruthy();
});

it("has no ready section when nothing was handed over", async () => {
  const rendered = await renderWithDb(
    <CreditsCard
      tier="free"
      host={{ openExternal: async () => {}, openUpgrade: async () => {} }}
    />
  );
  cleanup = rendered.cleanup;
  expect(document.querySelector('[data-slot="credits-ready"]')).toBeNull();
  expect(screen.queryByText("What's ready")).toBeNull();
});

describe("the free grant's milestone card", () => {
  const BILLING: BillingPlan = {
    current: {
      planName: "Free",
      creditsRemaining: 1000,
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
          "Unlimited chatting with the bot (20,000 credits a month)",
          "Top models including Model A, Model B, Model C, Model D and Model E",
          "Build and deploy powerful apps on the web, including mobile apps: 3 projects a month",
        ],
        url: null,
      },
    ],
    topUpUrl: null,
    upgradeInMobileApp: false,
  };
  const card = (
    threshold: 50 | 80,
    used: number,
    extra: Partial<Parameters<typeof CreditThresholdCard>[0]> = {}
  ) => (
    <CreditThresholdCard
      threshold={threshold}
      used={used}
      total={2000}
      estimate={null}
      billing={BILLING}
      onUpgrade={() => {}}
      onContinue={() => {}}
      {...extra}
    />
  );

  it("at half: the balance, today's estimate, the meter, the plan's gains and its first-month price", async () => {
    const rendered = await renderWithDb(
      card(50, 1000, { estimate: { count: 12, kind: "builds" } })
    );
    cleanup = rendered.cleanup;
    const dialog = await screen.findByRole("dialog");
    expect(
      screen.getByRole("heading", {
        name: "You've used half your free credits",
      })
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      "You have 1,000 of 2,000 left. That's about 12 more builds like today's."
    );
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("1000");
    expect(meter.getAttribute("aria-label")).toBe(
      "1,000 of 2,000 free credits used"
    );
    expect(
      [
        ...document.querySelectorAll(
          '[data-slot="credit-threshold-benefits"] li'
        ),
      ].map((item) => item.textContent)
    ).toEqual([
      "20,000 credits a month (10x the free plan)",
      "Top models: Model A, Model B, Model C, Model D",
      "Image and video generation",
      "Personal agents in Abacus AI Agent on the web that run 24/7, even with your computer off: WhatsApp, Discord and Telegram auto-replies, all your routines, and everything your bot does",
      "100+ connectors: Gmail, Google Calendar, Slack, Drive, Notion and more",
      "Build and deploy powerful apps on the web, including mobile apps: 3 projects a month",
    ]);
    expect(
      screen.getByRole("button", { name: "Upgrade · $7 first month" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue free" })).toBeTruthy();
  });

  it("at four fifths: what is left and the urge, with no estimate it cannot make", async () => {
    const rendered = await renderWithDb(card(80, 1640));
    cleanup = rendered.cleanup;
    const dialog = await screen.findByRole("dialog");
    expect(
      screen.getByRole("heading", { name: "Only 360 free credits left" })
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      "Upgrade now so your work doesn't stop halfway."
    );
    expect(dialog.textContent).not.toContain("Enough for about");
  });

  it("stays until a button is picked; Esc is Continue free", async () => {
    const onContinue = vi.fn();
    const rendered = await renderWithDb(card(50, 1000, { onContinue }));
    cleanup = rendered.cleanup;
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
  });

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
    credits_used: 1000,
  };
  const MARK: CreditThresholdMark = {
    reached: 50,
    at: 1,
    used: 1000,
    granted: 2000,
    perTask: 100,
    kind: "messages",
    told: null,
  };
  const host = async ({
    account = ACCOUNT as typeof ACCOUNT | null,
    prefs = {} as Partial<PrefsRow>,
    busy = false,
  } = {}) => {
    const os = implement(contract);
    const seed = defaultSeed();
    const harness = await createHarness("/", {
      seed: {
        ...seed,
        sessions: busy ? seed.sessions : [],
        prefs: fixturePrefs({
          creditThresholds: { "o1:u1": MARK },
          ...prefs,
        }),
      },
      procedures: {
        account: {
          abacus: os.account.abacus.handler(() => account),
          billingPlan: os.account.billingPlan.handler(() => BILLING),
        },
      },
    });
    const queryClient = harness.router.options.context.queryClient;
    const view = (
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={harness.appDb}>
            <CreditThresholdHost />
          </DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
    let rendered!: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(view);
    });
    cleanup = async () => {
      rendered.unmount();
      await harness.cleanup();
    };
    const steps = () =>
      harness.calls
        .filter(([name]) => name === "system.funnelStep")
        .map(([, input]) => (input as { step: string }).step);
    const cards = () =>
      harness.appDb.collections.prefs.get("app")?.dismissals
        .creditThresholdCards;
    return { harness, steps, cards };
  };

  it("shows once for a free account between turns, and Continue free keeps it away", async () => {
    const h = await host();
    await screen.findByRole("heading", {
      name: "You've used half your free credits",
    });
    expect(screen.getByRole("dialog").textContent).toContain(
      "That's about 10 more bot messages like today's."
    );
    await waitFor(() => expect(h.steps()).toEqual(["credit_card_50_shown"]));
    fireEvent.click(screen.getByRole("button", { name: "Continue free" }));
    await waitFor(() =>
      expect(h.cards()).toEqual({ "o1:u1": { shown: 50, answered: 50 } })
    );
    expect(h.steps()).toEqual([
      "credit_card_50_shown",
      "credit_card_50_continue",
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a dismissed threshold stays dismissed; the next one still shows", async () => {
    const answered = {
      dismissals: {
        ...fixturePrefs().dismissals,
        creditThresholdCards: { "o1:u1": { shown: 50, answered: 50 } },
      },
    } as Partial<PrefsRow>;
    await host({ prefs: answered });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await cleanup?.();
    cleanup = undefined;
    await host({
      account: { ...ACCOUNT, credits_used: 1640 },
      prefs: {
        ...answered,
        creditThresholds: { "o1:u1": { ...MARK, reached: 80, used: 1640 } },
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Only 360 free credits left" })
    ).toBeTruthy();
  });

  it("never for a paid plan, a spent grant (the out-of-credits card's) or over a running turn", async () => {
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    for (const options of [
      { account: { ...ACCOUNT, subscription_tier: "basic" } },
      { account: { ...ACCOUNT, credits_used: 2000 } },
      { busy: true },
    ]) {
      const h = await host(options);
      await settle();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(h.steps()).toEqual([]);
      await cleanup?.();
      cleanup = undefined;
    }
  });

  it("Upgrade opens the upgrade flow and answers the card", async () => {
    const h = await host();
    const upgrade = await screen.findByRole("button", {
      name: "Upgrade · $7 first month",
    });
    fireEvent.click(upgrade);
    await waitFor(() => expect(h.steps()).toContain("credit_card_50_upgrade"));
    await waitFor(() =>
      expect(h.cards()).toEqual({ "o1:u1": { shown: 50, answered: 50 } })
    );
  });

  const dialog = async (
    request: UpgradeDialogRequest,
    {
      account = { ...ACCOUNT, credits_used: 2000 } as typeof ACCOUNT,
      billing = BILLING as BillingPlan | null,
      openExternal = vi.fn(),
    } = {}
  ) => {
    const os = implement(contract);
    const harness = await createHarness("/", {
      seed: { ...defaultSeed(), sessions: [] },
      procedures: {
        account: {
          abacus: os.account.abacus.handler(() => account),
          billingPlan: os.account.billingPlan.handler(() => billing),
        },
        system: { openExternal: os.system.openExternal.handler(openExternal) },
      },
    });
    let rendered!: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(
        <QueryClientProvider
          client={harness.router.options.context.queryClient}
        >
          <RouterContextProvider router={harness.router}>
            <DbProvider value={harness.appDb}>
              <UpgradeDialogHost />
            </DbProvider>
          </RouterContextProvider>
        </QueryClientProvider>
      );
    });
    cleanup = async () => {
      closeUpgradeDialog();
      rendered.unmount();
      await harness.cleanup();
    };
    act(() => requestUpgradeDialog(request, true));
    return screen.findByRole("dialog");
  };

  it("the out-of-credits dialog carries the plan's whole pitch and its price, never a renewal", async () => {
    const open = await dialog({ kind: "credits", key: "k1", threadId: "t1" });
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('[data-slot="upgrade-pitch"] li')]
          .map((item) => item.textContent)
          .toSorted()
      ).toEqual(
        [
          "20,000 credits a month (10x the free plan)",
          "Top models: Model A, Model B, Model C, Model D",
          "Image and video generation",
          "Personal agents in Abacus AI Agent on the web that run 24/7, even with your computer off: WhatsApp, Discord and Telegram auto-replies, all your routines, and everything your bot does",
          "100+ connectors: Gmail, Google Calendar, Slack, Drive, Notion and more",
          "Build and deploy powerful apps on the web, including mobile apps: 3 projects a month",
        ].toSorted()
      )
    );
    expect(open.textContent).toContain("Your free credits are used up");
    expect(open.textContent).toContain("$7 your first month, then $10/month");
    expect(open.textContent).not.toMatch(/renew/i);
    expect(
      screen.getByRole("button", { name: "Upgrade to Basic" })
    ).toBeTruthy();
  });

  it("a plan ask made at checkout (a card's Upgrade) opens on the dialog's wait for the plan", async () => {
    const open = await dialog({
      kind: "plan",
      key: "k3",
      threadId: "success-pitch",
      checkout: true,
    });
    await waitFor(() =>
      expect(open.textContent).toContain("Finish checkout in your browser")
    );
    expect(screen.getByRole("button", { name: "I've upgraded" })).toBeTruthy();
  });

  const PRO_TIER = {
    plan: "pro",
    planName: "Pro",
    priceText: "$20/mo",
    firstMonthPriceCents: 2000,
    priceCents: 2000,
    features: ["Everything in Basic", "30,000 credits a month"],
    url: "https://example.com/upgrade/pro",
  };
  const BASIC_OUT: BillingPlan = {
    current: {
      plan: "basic",
      planName: "Basic",
      creditsRemaining: 0,
      creditsGranted: 20000,
      freeTierExpiresAt: null,
    },
    plans: [
      {
        plan: "basic",
        planName: "Basic",
        priceText: "$10/mo",
        features: [],
        creditsPerMonth: 20000,
        current: true,
      },
      { ...PRO_TIER, creditsPerMonth: 40000, current: false },
    ],
    upgrades: [PRO_TIER],
    topUpUrl: "https://example.com/plans?buyCredits=true",
    upgradeInMobileApp: false,
  };
  const BASIC_ACCOUNT = {
    ...ACCOUNT,
    subscription_tier: "basic",
    credits_granted: 20000,
    credits_used: 20000,
  };
  const PRO_OUT: BillingPlan = {
    ...BASIC_OUT,
    current: { ...BASIC_OUT.current, plan: "pro", planName: "Pro" },
    plans: [],
    upgrades: [
      {
        plan: "max",
        planName: "Max",
        priceText: "$200/mo",
        priceCents: 20000,
        features: ["Everything in Pro", "300,000 credits a month"],
        url: "https://example.com/upgrade/max",
      },
    ],
  };
  const PRO_ACCOUNT = { ...BASIC_ACCOUNT, subscription_tier: "pro" };

  it("Basic out of credits gets the free plan's dialog for Pro: price, whole pitch, Upgrade, no Top up", async () => {
    const openExternal = vi.fn();
    const open = await dialog(
      { kind: "credits", key: "basic1", threadId: "t1", pendingText: "go on" },
      { account: BASIC_ACCOUNT, billing: BASIC_OUT, openExternal }
    );
    await waitFor(() =>
      expect(document.querySelector('[data-slot="upgrade-pitch"]')).toBeTruthy()
    );
    expect(open.textContent).toContain("You've used this month's credits");
    expect(open.textContent).toContain("Keep going with AbacusAI Bot");
    expect(open.textContent).toContain("Upgrade and it sends right away.");
    expect(open.textContent).toContain("$20/month");
    expect(open.textContent).toContain("Pro plan · cancel anytime");
    expect(
      document.querySelector('[data-slot="upgrade-pitch"]')?.textContent
    ).toContain("40,000 credits a month (2x your Basic plan)");
    // Never the free plan's wording, never a top-up.
    expect(open.textContent).not.toContain("free");
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
    expect(
      document.querySelector('[data-slot="upgrade-paid-offer"]')
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { url: "https://example.com/upgrade/pro" },
        })
      )
    );
    await waitFor(() =>
      expect(open.textContent).toContain("Finish checkout in your browser")
    );
    expect(screen.getByRole("button", { name: "I've upgraded" })).toBeTruthy();
  });

  it("Pro out of credits is offered a top-up and Max, priced by the server", async () => {
    const openExternal = vi.fn();
    const open = await dialog(
      { kind: "credits", key: "pro1", threadId: "t1", pendingText: "go on" },
      { account: PRO_ACCOUNT, billing: PRO_OUT, openExternal }
    );
    // The title shows before the plan read lands; the offer follows it.
    await waitFor(() =>
      expect(open.textContent).toContain("Or move up to Max — $200/month")
    );
    expect(open.textContent).toContain("You've used this month's credits");
    expect(open.textContent).toContain("300,000 credits a month");
    expect(document.querySelector('[data-slot="upgrade-pitch"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade to Max" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Top up" }));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { url: "https://example.com/plans?buyCredits=true" },
        })
      )
    );
    await waitFor(() =>
      expect(open.textContent).toContain("Finish in your browser")
    );
    expect(screen.getByRole("button", { name: "I've paid" })).toBeTruthy();
  });

  it("a store-billed paid plan is sent to the mobile app, with no link to buy here", async () => {
    const open = await dialog(
      { kind: "credits", key: "paid2", threadId: "t1" },
      {
        account: BASIC_ACCOUNT,
        billing: {
          ...BASIC_OUT,
          upgrades: BASIC_OUT.upgrades.map((tier) => ({ ...tier, url: null })),
          topUpUrl: null,
          upgradeInMobileApp: true,
        },
      }
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="paid-offer-mobile"]')
      ).toBeTruthy()
    );
    expect(open.textContent).toContain("Abacus.AI mobile app");
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
  });

  it("a paid plan the server offers nothing to gets no dialog", async () => {
    const os = implement(contract);
    const harness = await createHarness("/", {
      seed: { ...defaultSeed(), sessions: [] },
      procedures: {
        account: {
          abacus: os.account.abacus.handler(() => BASIC_ACCOUNT),
          billingPlan: os.account.billingPlan.handler(() => null),
        },
      },
    });
    let rendered!: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(
        <QueryClientProvider
          client={harness.router.options.context.queryClient}
        >
          <RouterContextProvider router={harness.router}>
            <DbProvider value={harness.appDb}>
              <UpgradeDialogHost />
            </DbProvider>
          </RouterContextProvider>
        </QueryClientProvider>
      );
    });
    cleanup = async () => {
      closeUpgradeDialog();
      rendered.unmount();
      await harness.cleanup();
    };
    act(() =>
      requestUpgradeDialog({ kind: "credits", key: "paid3", threadId: "t1" })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an expired free tier's dialog says it expired", async () => {
    const open = await dialog({
      kind: "credits",
      key: "k2",
      threadId: "t1",
      expired: true,
    });
    await waitFor(() =>
      expect(open.textContent).toContain("Your free credits have expired")
    );
  });
});

describe("the cut-off card once the credits are used up", () => {
  const offerFor = (plan: string, next: string, nextName: string) =>
    ({
      current: {
        plan,
        planName: plan,
        creditsRemaining: 0,
        creditsGranted: 20000,
        freeTierExpiresAt: null,
      },
      plans: [],
      upgrades: [
        {
          plan: next,
          planName: nextName,
          priceText: "$20/mo",
          priceCents: 2000,
          features: [`Everything in ${plan}`],
          url: `https://example.com/upgrade/${next}`,
        },
      ],
      topUpUrl: "https://example.com/plans?buyCredits=true",
      upgradeInMobileApp: false,
    }) as BillingPlan;
  const card = async (paid: boolean, billing: BillingPlan) => {
    const onUpgrade = vi.fn();
    const onTopUp = vi.fn();
    const onNextPlan = vi.fn();
    const rendered = await renderWithDb(
      <CutOffCard
        host={{
          openExternal: async () => {},
          openUpgrade: async () => {},
          billingPlan: async () => billing,
        }}
        state="out"
        paid={paid}
        streamed={false}
        label="Gemini"
        resolved={null}
        onUpgrade={onUpgrade}
        onTopUp={onTopUp}
        onNextPlan={onNextPlan}
      />
    );
    cleanup = rendered.cleanup;
    return { onUpgrade, onTopUp, onNextPlan };
  };

  it("free: the plan's pitch and its Upgrade, as before", async () => {
    const { onUpgrade } = await card(false, offerFor("free", "basic", "Basic"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Upgrade to Basic" })
    );
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(
      screen.getByText("You've also used your free Abacus credits.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
  });

  it("Basic: the same pitch and Upgrade, for Pro, and no Top up", async () => {
    const { onUpgrade, onNextPlan } = await card(
      true,
      offerFor("basic", "pro", "Pro")
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Upgrade to Pro" })
    );
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(onNextPlan).not.toHaveBeenCalled();
    expect(screen.getByText("You've used this month's credits")).toBeTruthy();
    expect(screen.getByText("Pro gets you:")).toBeTruthy();
    expect(screen.queryByText(/free Abacus credits/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
  });

  it("Pro: Top up and Upgrade to Max", async () => {
    const { onTopUp, onNextPlan, onUpgrade } = await card(
      true,
      offerFor("pro", "max", "Max")
    );
    fireEvent.click(await screen.findByRole("button", { name: "Top up" }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(onTopUp).toHaveBeenCalledOnce();
    expect(onNextPlan).toHaveBeenCalledOnce();
    expect(onUpgrade).not.toHaveBeenCalled();
  });
});
