import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { onboardingStore } from "#renderer/features/onboarding";
import {
  firstBotStore,
  noteConnectedChatApp,
} from "#renderer/features/onboarding/first-bot";
import { startDraftStore } from "#renderer/features/sessions/start/start-session";
import { GOAL_MISSION } from "#renderer/lib/bots/check-in";
import {
  renderApp,
  defaultSeed,
  type AppHarness,
} from "#renderer/test-support/app-harness";
let harness: (AppHarness & { view: { unmount(): void } }) | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});
beforeEach(() => {
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  firstBotStore.setState(() => ({ state: "idle" }));
});
it("R6-T2 fresh account reaches onboarding before shell; signed-out onboarded account returns to the sign-in wall", async () => {
  harness = await renderApp("/bots/new", { onboarded: false });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  harness.view.unmount();
  await harness.cleanup();
  harness = await renderApp("/bots/new", { onboarded: true, signedIn: false });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(
    await screen.findByRole("button", { name: "Sign up for free" })
  ).toBeTruthy();
});
it("R6-T7 real router preserves failed attempts and resumes persisted authentication after cancellation", async () => {
  let outcome!: (value: { ok: false; error: string } | { ok: true }) => void;
  harness = await renderApp("/onboarding/welcome", {
    onboarded: false,
    authStart: () =>
      new Promise((resolve) => {
        outcome = resolve;
      }),
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign up for free" })
  );
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/connect")
  );
  await act(async () => {
    outcome({ ok: false, error: "auth-failed" });
  });
  expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  await act(async () => {
    await harness!.router.invalidate();
  });
  expect(harness.router.state.location.pathname).toBe("/onboarding/connect");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      harness!.calls.filter(([name]) => name === "auth.abacus.start")
    ).toHaveLength(2)
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(onboardingStore.state.signIn).toBeNull();
  await act(async () => {
    // The host has saved credentials even though this attempt was cancelled.
    // Ignore its stale handoff, not the authenticated route guard's answer.
    outcome({ ok: true });
  });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe(
      "/onboarding/connected"
    )
  );
  expect(onboardingStore.state.signIn).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign up for free" })).toBeNull();
  expect(
    (await harness.transport.client.settings.get({})).apiKeys?.ABACUS_API_KEY
  ).toBeTruthy();
  expect(
    harness.calls.filter(([name]) => name === "auth.abacus.start")
  ).toHaveLength(2);
});

it.each([null, "telegram"] as const)(
  "R6-T8 authenticated completion creates one first bot after onboarding, chat app connected=%s",
  async (chatApp) => {
    const seed = defaultSeed();
    seed.bots = [];
    seed.routines = [];
    // A free account signed in with Abacus and no key of its own: no models step.
    harness = await renderApp("/onboarding/connected", {
      onboarded: false,
      signedIn: true,
      seed,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(
        "/onboarding/connectors"
      )
    );
    expect(
      harness.calls.filter(
        ([name, input]) =>
          name === "system.funnelStep" &&
          (input as { step: string }).step === "screen_models"
      )
    ).toHaveLength(0);
    await screen.findByRole("heading", {
      name: /Connect with your tools & services\.\s*Chat where you work\./,
    });
    const continueConnectors = await screen.findByRole("button", {
      name: "Continue",
    });
    await waitFor(() =>
      expect((continueConnectors as HTMLButtonElement).disabled).toBe(false)
    );
    // What the connectors step's chat-app dialog notes once it links.
    if (chatApp != null) noteConnectedChatApp(chatApp);
    fireEvent.click(continueConnectors);
    if (chatApp == null) {
      const box = await screen.findByRole("textbox", { name: "What you need" });
      fireEvent.change(box, { target: { value: "Kaggle notebooks" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    } else fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toMatch(/^\/bots\/bot-/)
    );
    const ownBots = harness.collections.bots.toArray;
    expect(ownBots).toHaveLength(1);
    expect(harness.collections.routines.toArray).toHaveLength(0);
    // The first thing made runs on the house, whichever it is.
    expect(ownBots[0]).toMatchObject({ sponsoredFirstRun: true });
    if (chatApp == null) {
      // The user's own words are the mission: no template, nothing to connect up front.
      expect(ownBots[0]!.description).toBe(GOAL_MISSION("Kaggle notebooks"));
      expect(ownBots[0]!.templateId).toBeUndefined();
    } else {
      expect(ownBots[0]).toMatchObject({
        name: "Telegram Agent",
        homeChannel: "telegram",
        templateId: "telegram-agent",
      });
      expect(ownBots[0]!.description).toContain("Live in my Telegram.");
    }
    // Completion clears the exit only after the destination navigation settles.
    await waitFor(() =>
      expect(harness!.collections.prefs.get("app")).toMatchObject({
        onboardingStep: null,
        onboardingExit: null,
      })
    );
    expect(
      harness.calls.filter(([name]) => name === "account.skipOnboarding")
    ).toHaveLength(1);
    expect(
      harness.calls.filter(
        ([name, input]) =>
          name === "system.funnelStep" &&
          (input as { step: string }).step === "onboarding_done"
      )
    ).toEqual([["system.funnelStep", { step: "onboarding_done", once: true }]]);
  },
  15000
);
it("Start building opens a new session on the build examples and makes no bot", async () => {
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  harness = await renderApp("/onboarding/first-bot", {
    onboarded: false,
    signedIn: true,
    seed,
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Start building",
    })
  );
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/sessions/new")
  );
  expect(harness.collections.bots.toArray).toHaveLength(0);
  expect(harness.collections.routines.toArray).toHaveLength(0);
  expect(startDraftStore.state).toMatchObject({
    starters: "build",
    sponsored: true,
  });
  expect(
    await screen.findByRole("button", { name: /Portfolio site/ })
  ).toBeTruthy();
  expect(
    harness.calls.filter(([name]) => name === "account.skipOnboarding")
  ).toHaveLength(1);
});

it("See Basic on a free account opens the upgrade dialog with the plan's whole pitch, not a page", async () => {
  const os = implement(contract);
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  harness = await renderApp("/onboarding/first-bot", {
    onboarded: false,
    signedIn: true,
    seed,
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => ({
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
          credits_used: 0,
        })),
        billingPlan: os.account.billingPlan.handler(
          () =>
            ({
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
                  priceText: "Free",
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
            }) as never
        ),
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "See Basic" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(
      dialog.querySelectorAll('[data-slot="upgrade-pitch"] li')
    ).toHaveLength(6)
  );
  expect(within(dialog).getByText("Everything Basic gives you")).toBeTruthy();
  expect(dialog.textContent).toContain("$7 your first month, then $10/month");
  expect(
    harness.calls.filter(([name]) => name === "system.openExternal")
  ).toHaveLength(0);
  expect(harness.router.state.location.pathname).toBe("/onboarding/first-bot");
});

it("the first-run choices wait for a pick, and a pick opens the bot it made", async () => {
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  harness = await renderApp("/onboarding/first-bot", {
    onboarded: false,
    signedIn: true,
    seed,
  });
  const research = await screen.findByRole("button", { name: "Start" });
  expect(screen.getByRole("button", { name: "Start building" })).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });
  expect(harness.router.state.location.pathname).toBe("/onboarding/first-bot");
  expect(harness.collections.bots.toArray).toHaveLength(0);
  fireEvent.click(research);
  await waitFor(
    () =>
      expect(harness!.router.state.location.pathname).toMatch(/^\/bots\/bot-/),
    { timeout: 5000 }
  );
  expect(harness.collections.bots.toArray).toHaveLength(1);
  expect(harness.collections.bots.toArray[0]).toMatchObject({
    name: "Research Assistant",
    sponsoredFirstRun: true,
  });
  expect(
    harness.calls.filter(([name]) => name === "account.skipOnboarding")
  ).toHaveLength(1);
  await waitFor(() =>
    expect(
      harness!.calls.filter(([name]) => name === "bots.openChat")
    ).toHaveLength(1)
  );
});

it("after a Gmail sign-in the Chief of Staff starts on the inbox while the screen waits for it", async () => {
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  const os = implement(contract);
  harness = await renderApp("/onboarding/first-bot", {
    onboarded: false,
    signedIn: true,
    seed,
    procedures: {
      connectors: {
        statuses: os.connectors.statuses.handler(
          () => ({ "abacus-gmailuser": { state: "connected" } }) as never
        ),
      },
    },
  });
  expect(
    await screen.findByRole("heading", {
      name: "Reading your last 3 days of email…",
    })
  ).toBeTruthy();
  expect(harness.collections.bots.toArray).toHaveLength(1);
  expect(harness.collections.bots.toArray[0]).toMatchObject({
    templateId: "chief-of-staff",
    sponsoredFirstRun: true,
  });
  await waitFor(() =>
    expect(
      harness!.calls.filter(([name]) => name === "bots.openChat")
    ).toHaveLength(1)
  );
  expect(harness.router.state.location.pathname).toBe("/onboarding/first-bot");
  fireEvent.click(screen.getByRole("button", { name: "Watch it work" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe(
      `/bots/${harness!.collections.bots.toArray[0]!.id}`
    )
  );
  expect(harness.collections.bots.toArray).toHaveLength(1);
});

it("final setup retries a failed completion without duplicating the bot it made", async () => {
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  const os = implement(contract);
  let attempts = 0;
  let onboarded = false;
  harness = await renderApp("/onboarding/first-bot", {
    onboarded: false,
    signedIn: true,
    seed,
    procedures: {
      account: {
        state: os.account.state.handler(() => ({
          account: null,
          apps: [],
          onboarded,
        })),
        skipOnboarding: os.account.skipOnboarding.handler(() => {
          attempts += 1;
          if (attempts === 1) throw new Error("offline");
          onboarded = true;
          return { account: null, apps: [], onboarded };
        }),
      },
    },
  });
  const hello = await screen.findByRole("button", { name: "Start" });
  fireEvent.click(hello);
  await screen.findByRole("alert");
  expect(harness.router.state.location.pathname).toBe("/onboarding/first-bot");
  expect(harness.collections.bots.toArray).toHaveLength(1);
  const botId = harness.collections.bots.toArray[0]!.id;
  fireEvent.click(hello);
  fireEvent.click(hello);
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe(`/bots/${botId}`)
  );
  expect(attempts).toBe(2);
  expect(harness.collections.bots.toArray).toHaveLength(1);
});

it("a website signup is welcomed and set up like any sign-in", async () => {
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  const os = implement(contract);
  harness = await renderApp("/onboarding/connected", {
    onboarded: false,
    signedIn: true,
    seed,
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => ({
          user_id: "fixture-user",
          organization_id: null,
          name: null,
          email: null,
          picture: null,
          organization: null,
          org_user_count: null,
          plan: "Free",
          subscription_tier: "FREE",
          credits_used: null,
          credits_granted: null,
          web_signup: true,
        })),
      },
    },
  });
  // The welcome screen stays: a website signup is not sent past it.
  expect(
    await screen.findByRole("button", { name: "Get started" })
  ).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(harness.router.state.location.pathname).toBe("/onboarding/connected");
  // Then the setup screens, as for any sign-in.
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toMatch(
      /^\/onboarding\/(models|connectors)$/
    )
  );
  expect(harness.collections.bots.toArray).toHaveLength(0);
});

/**
 * `settings.events` streams the test feeds (every follower's), and a host
 * whose sign-in it flips.
 */
const settingsHost = () => {
  const os = implement(contract);
  const host = { signedIn: true, reads: 0, opens: 0 };
  const streams = new Set<{ send(event: unknown): void; end(): void }>();
  const procedures = {
    settings: {
      get: os.settings.get.handler(() => {
        host.reads += 1;
        return {
          defaultModel: null,
          apiKeys: host.signedIn ? { ABACUS_API_KEY: "test-credential" } : {},
        } as never;
      }),
      events: os.settings.events.handler(async function* ({ signal }) {
        host.opens += 1;
        const queue: unknown[] = [];
        let wake = () => {};
        let ended = false;
        const stream = {
          send: (event: unknown) => {
            queue.push(event);
            wake();
          },
          end: () => {
            ended = true;
            wake();
          },
        };
        streams.add(stream);
        signal?.addEventListener("abort", () => wake(), { once: true });
        try {
          while (!signal?.aborted && !ended) {
            if (queue.length > 0) yield queue.shift() as never;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        } finally {
          streams.delete(stream);
        }
      }),
    },
  };
  return {
    host,
    procedures,
    notify: (event: unknown) => {
      for (const stream of streams) stream.send(event);
    },
    drop: () => {
      for (const stream of Array.from(streams)) stream.end();
    },
    open: () => streams.size,
  };
};
it("the shell gate reads settings once, skips hover preloads, and a credential notice signs the shell out", async () => {
  const { host, procedures, notify, open } = settingsHost();
  harness = await renderApp("/bots/new", { procedures });
  const first = host.reads;
  expect(first).toBeGreaterThan(0);
  await waitFor(() => expect(open()).toBeGreaterThan(0));
  for (const href of ["/sessions/new", "/routines", "/library/connectors"])
    await act(() => harness!.router.preloadRoute({ to: href as never }));
  await act(() => harness!.router.navigate({ to: "/routines" }));
  await act(() => harness!.router.navigate({ to: "/bots/new" }));
  expect(host.reads).toBe(first);
  // The host signs out (another window, a revoked key) and says so.
  host.signedIn = false;
  await act(async () => {
    notify({ type: "credentials-changed", provider: "abacus" });
  });
  await act(() => harness!.router.navigate({ to: "/routines" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(host.reads).toBeGreaterThan(first);
});
it("a reopened settings stream re-reads the gate's settings: a notice may have been lost", async () => {
  const { host, procedures, drop, open } = settingsHost();
  harness = await renderApp("/bots/new", { procedures });
  await waitFor(() => expect(open()).toBeGreaterThan(0));
  const first = host.reads;
  const opens = host.opens;
  // Signed out while the stream was down: no notice will ever say so.
  host.signedIn = false;
  await act(async () => drop());
  await waitFor(() => expect(host.opens).toBeGreaterThanOrEqual(2 * opens), {
    timeout: 3_000,
  });
  await act(() => harness!.router.navigate({ to: "/routines" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(host.reads).toBeGreaterThan(first);
});
it.each(["/bots/new", "/bots/new?step=setup", "/routines"])(
  "%s renders before its non-essential queries answer",
  async (path) => {
    const os = implement(contract);
    const never = () => new Promise<never>(() => undefined);
    harness = await renderApp(path, {
      procedures: {
        bots: {
          chatPreviews: os.bots.chatPreviews.handler(never),
          senderChats: os.bots.senderChats.handler(never),
        },
        connectors: { statuses: os.connectors.statuses.handler(never) },
        messaging: { snapshot: os.messaging.snapshot.handler(never) },
        models: { list: os.models.list.handler(never) },
      },
    });
    await waitFor(() => expect(harness!.router.state.status).toBe("idle"));
    expect(harness.router.state.matches.at(-1)?.status).toBe("success");
  }
);
it("signing out on the account page reaches the sign-in wall without waiting for a notice", async () => {
  const { host, procedures } = settingsHost();
  const os = implement(contract);
  harness = await renderApp("/settings/account", {
    procedures: {
      ...procedures,
      account: {
        abacus: os.account.abacus.handler(() =>
          host.signedIn
            ? ({ name: "Ada", email: "ada@example.com", plan: null } as never)
            : null
        ),
        signOut: os.account.signOut.handler(() => {
          host.signedIn = false;
          return { account: null, apps: [], onboarded: true } as never;
        }),
      },
      auth: {
        abacus: {
          signOut: os.auth.abacus.signOut.handler(() => ({}) as never),
        },
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: /^Sign out/ }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /^Sign out/ }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
});

it.each(["whatsapp", "telegram", "discord"] as const)(
  "pairs %s in an onboarding overlay and returns to the same step on close",
  async (platform) => {
    const os = implement(contract);
    const snapshot = {
      gatewayEnabled: true,
      autoApproveTools: false,
      respondToInbound: false,
      workspaceId: null,
      botId: null,
      approved: [],
      pending: [],
      autoReplies: [],
      platforms: [
        platform,
        ...(platform === "discord" ? ["abacus_discord" as const] : []),
      ].map((id) => ({
        id,
        nameKey: id,
        enabled: false,
        configured: true,
        state: "needs_login" as const,
        fields: [],
        docsUrl: "",
        errorMessage: null,
        pendingCount: 0,
        sharedLink: { status: "pending" as const },
      })),
    };
    const writes: { platformId: string; enabled?: boolean }[] = [];
    const released: string[] = [];
    harness = await renderApp("/onboarding/connectors", {
      onboarded: false,
      signedIn: true,
      procedures: {
        messaging: {
          snapshot: os.messaging.snapshot.handler(() => snapshot),
          updatePlatform: os.messaging.updatePlatform.handler(({ input }) => {
            writes.push(input);
            return snapshot;
          }),
          showLogin: os.messaging.showLogin.handler(() => {}),
          releaseLogin: os.messaging.releaseLogin.handler(({ input }) => {
            released.push(input.platformId);
          }),
          pairShared: os.messaging.pairShared.handler(() => snapshot),
        },
      },
    });
    const names = {
      whatsapp: "WhatsApp",
      telegram: "Telegram",
      discord: "Discord",
    };
    const trigger = await screen.findByRole("button", {
      name: `Connect ${names[platform]}`,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog");
      expect(harness.router.state.location.pathname).toBe(
        "/onboarding/connectors"
      );
      expect(
        document.querySelector('[data-onboarding-step="connectors"]')
      ).not.toBeNull();
      await waitFor(() =>
        expect(
          writes.some((write) => write.platformId === platform && write.enabled)
        ).toBe(true)
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(harness.router.state.location.pathname).toBe(
        "/onboarding/connectors"
      );
      await waitFor(() =>
        expect(released).toEqual(Array(attempt + 1).fill(platform))
      );
      expect(writes.some((write) => write.enabled === false)).toBe(false);
    }
    expect(
      harness.collections.prefs.get("app")?.onboardingPairing ?? []
    ).toEqual([]);
  }
);
it("a slow connectors read past the pending skeleton still opens the connectors step", async () => {
  const os = implement(contract);
  // Slower than defaultPendingMs: the skeleton unmounts the outgoing step
  // while the loader waits, and the connectors step's own query refetches.
  const slow = () =>
    new Promise<Record<string, never>>((resolve) =>
      setTimeout(() => resolve({}), 800)
    );
  harness = await renderApp("/onboarding/connected", {
    onboarded: false,
    signedIn: true,
    procedures: {
      connectors: { statuses: os.connectors.statuses.handler(slow) },
    },
  });
  const getStarted = await screen.findByRole("button", {
    name: "Get started",
  });
  await waitFor(() =>
    expect((getStarted as HTMLButtonElement).disabled).toBe(false)
  );
  fireEvent.click(getStarted);
  await screen.findByRole(
    "heading",
    { name: /Connect with your tools & services\./ },
    { timeout: 4_000 }
  );
  expect(screen.queryByText("Something went wrong")).toBeNull();
});
