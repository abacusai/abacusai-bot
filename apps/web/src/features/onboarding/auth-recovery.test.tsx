import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { onboardingStore } from "./store";
import * as signInStore from "./store";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  vi.restoreAllMocks();
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
});

it("resumes setup instead of showing signup when the account is already signed in", async () => {
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: true,
  });
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
  expect(screen.queryByRole("button", { name: "Sign up for free" })).toBeNull();
});

it("finishes a Google sign-in without opening Gmail's consent", async () => {
  const connect = vi.fn(async () => ({ ok: true }) as never);
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: false,
    authStart: async () => ({ ok: true }),
    procedures: {
      account: {
        abacus: os.account.abacus.handler(
          () =>
            ({
              email: "demo@example.test",
              subscription_tier: "free",
              google_sign_in: true,
            }) as never
        ),
      },
      connectors: {
        statuses: os.connectors.statuses.handler(
          async () => ({ "abacus-gmailuser": { state: "available" } }) as never
        ),
        connect: os.connectors.connect.handler(connect),
      },
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign up for free" })
  );
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
  // Gmail is offered on the connectors screen only, never opened unasked.
  expect(connect).not.toHaveBeenCalled();
});

it("offers retry when refreshing the signed-in account fails", async () => {
  let refreshes = 0;
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: false,
    authStart: async () => ({ ok: true }),
    procedures: {
      account: {
        abacus: os.account.abacus.handler(({ input }) => {
          if (input?.refresh && ++refreshes === 1)
            throw new Error("account service offline");
          return { email: "", subscription_tier: "free" } as never;
        }),
      },
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign up for free" })
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(onboardingStore.state.signIn?.status).toBe("failed");
  expect(screen.getByRole("alert")).not.toBeNull();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
});

it("cancel after credentials are saved skips signup without allowing a stale handoff", async () => {
  let releaseAccount!: (value: {
    email: string;
    subscription_tier: string;
  }) => void;
  const account = new Promise<{ email: string; subscription_tier: string }>(
    (resolve) => {
      releaseAccount = resolve;
    }
  );
  let finished!: () => void;
  const settled = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const original = signInStore.startSignIn;
  vi.spyOn(signInStore, "startSignIn").mockImplementation(
    (transport, intent, callback) =>
      original(transport, intent, async (outcome) => {
        try {
          await callback(outcome);
        } finally {
          finished();
        }
      })
  );
  let refreshing = false;
  const authStart = vi.fn(async () => ({ ok: true as const }));
  const connect = vi.fn(
    async () => ({ ok: false, error: "cancelled" }) as never
  );
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: false,
    authStart,
    procedures: {
      account: {
        abacus: os.account.abacus.handler(({ input }) => {
          if (input?.refresh) {
            refreshing = true;
            return account as never;
          }
          return { email: "", subscription_tier: "free" } as never;
        }),
      },
      connectors: {
        statuses: os.connectors.statuses.handler(() => ({})),
        connect: os.connectors.connect.handler(connect),
      },
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign up for free" })
  );
  await waitFor(() => expect(refreshing).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
  const currentAttempt = onboardingStore.state.signIn?.id;
  await act(async () => {
    releaseAccount({ email: "demo@example.test", subscription_tier: "free" });
    await settled;
  });
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
  expect(screen.queryByRole("button", { name: "Sign up for free" })).toBeNull();
  expect(authStart).toHaveBeenCalledOnce();
  expect(connect).not.toHaveBeenCalled();
  expect(onboardingStore.state.signIn?.id).toBe(currentAttempt);
});

const paymentScreens = [
  {
    reason: "unconfirmed",
    title: "Choose a plan to keep using AbacusAI Bot",
    cta: "Upgrade",
  },
  {
    reason: null,
    title: "Choose a plan to keep using AbacusAI Bot",
    cta: "Upgrade",
  },
  { reason: "trial_ended", title: "Your free trial has ended", cta: "Upgrade" },
  { reason: "lapsed", title: "Your subscription has ended", cta: "Renew" },
] as const;

it.each(paymentScreens)(
  "a sign-in refused for payment ($reason) shows its screen, once, not the sign-in again",
  async ({ reason, title, cta }) => {
    let held = false;
    const authStart = vi.fn(async () => {
      held = true;
      return { ok: false as const, error: "payment-required" };
    });
    app = await renderApp("/onboarding/welcome", {
      onboarded: false,
      signedIn: false,
      authStart,
      procedures: {
        account: {
          payment: os.account.payment.handler(() =>
            held ? ((reason != null ? { reason } : {}) as never) : null
          ),
          billingPlan: os.account.billingPlan.handler(
            () =>
              ({
                current: {
                  planName: "Free",
                  creditsRemaining: null,
                  creditsGranted: null,
                  freeTierExpiresAt: null,
                },
                plans: [
                  {
                    plan: "free",
                    planName: "Free",
                    priceText: "Free",
                    features: [],
                    creditsPerMonth: 2000,
                    current: true,
                  },
                  {
                    plan: "basic",
                    planName: "Basic",
                    priceText: "Intro offer",
                    features: [],
                    creditsPerMonth: 20000,
                    current: false,
                  },
                ],
                upgrades: [
                  {
                    plan: "basic",
                    planName: "Basic",
                    priceText: "Intro offer",
                    features: [
                      "Top models including Model A, Model B, Model C, Model D and Model E",
                    ],
                    url: null,
                  },
                ],
                topUpUrl: null,
                upgradeInMobileApp: false,
              }) as never
          ),
        },
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign up for free" })
    );

    expect(await screen.findByRole("heading", { name: title })).not.toBeNull();
    expect(screen.getByRole("button", { name: cta })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Go to Abacus AI Agent on the web →" })
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign in with a different account" })
    ).not.toBeNull();
    // The plan comes from billing_plan; a lapsed plan is renewed, not sold.
    await waitFor(() =>
      expect(screen.queryByText("Upgrade to Basic — Intro offer") != null).toBe(
        reason !== "lapsed"
      )
    );
    expect(
      screen.queryByRole("button", { name: "Sign up for free" })
    ).toBeNull();
    // The offer carries the plan's whole pitch, never a part of it.
    expect(
      [...document.querySelectorAll('[data-slot="payment-offer"] li')].map(
        (item) => item.textContent
      )
    ).toEqual(
      reason === "lapsed"
        ? []
        : [
            "20,000 credits a month (10x the free plan)",
            "Top models: Model A, Model B, Model C, Model D",
            "Image and video generation",
            "Personal agents in Abacus AI Agent on the web that run 24/7, even with your computer off: WhatsApp, Discord and Telegram auto-replies, all your routines, and everything your bot does",
            "100+ connectors: Gmail, Google Calendar, Slack, Drive, Notion and more",
            "Build and deploy powerful apps on the web, including mobile apps",
          ]
    );
    // Only a plan whose payment did not confirm offers subscribers a report.
    expect(
      screen.queryByRole("button", { name: "Report an issue" }) != null
    ).toBe(reason === "unconfirmed" || reason == null);
    expect(authStart).toHaveBeenCalledOnce();
  }
);

it("Try again after paying on the web signs in without a restart", async () => {
  let paid = false;
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: false,
    authStart: async () => ({ ok: false, error: "payment-required" }),
    procedures: {
      settings: {
        get: os.settings.get.handler(
          () =>
            ({
              defaultModel: null,
              apiKeys: paid ? { ABACUS_API_KEY: "test-credential" } : {},
            }) as never
        ),
      },
      account: {
        payment: os.account.payment.handler(({ input }) => {
          if (input?.refresh) paid = true;
          return paid ? null : { reason: "trial_ended" };
        }),
      },
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign up for free" })
  );
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
  expect(
    screen.queryByRole("heading", { name: "Your free trial has ended" })
  ).toBeNull();
});
