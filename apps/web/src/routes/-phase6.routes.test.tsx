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
import { firstBotStore } from "#renderer/features/onboarding/first-bot";
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
it("R6-T7 real router preserves failed attempts and ignores cancellation's late success", async () => {
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
  await act(async () => {
    outcome({ ok: true });
  });
  expect(harness.router.state.location.pathname).toBe("/onboarding/welcome");
});

it.each([false, true])(
  "R6-T8 authenticated completion creates one sponsored Chief of Staff after onboarding, channel lane=%s",
  async (hasChannelLane) => {
    const seed = defaultSeed();
    seed.bots = hasChannelLane
      ? [{ ...seed.bots![0]!, channel: "telegram" }]
      : [];
    seed.routines = [];
    harness = await renderApp("/onboarding/models", {
      onboarded: false,
      signedIn: true,
      seed,
    });
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/onboarding/models")
    );
    const continueModels = await screen.findByRole("button", {
      name: "Continue",
    });
    await waitFor(() =>
      expect((continueModels as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(continueModels);
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(
        "/onboarding/connectors"
      )
    );
    await screen.findByRole("heading", {
      name: /Connect with your tools & services\.\s*Chat where you work\./,
    });
    const continueConnectors = await screen.findByRole("button", {
      name: "Continue",
    });
    await waitFor(() =>
      expect((continueConnectors as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(continueConnectors);
    fireEvent.click(await screen.findByRole("button", { name: "Say hello" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Message Chief of Staff" })
    );
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toMatch(/^\/bots\/bot-/)
    );
    const ownBots = harness.collections.bots.toArray.filter(
      (bot) => bot.channel == null
    );
    expect(ownBots).toHaveLength(1);
    expect(ownBots[0]).toMatchObject({
      sponsoredFirstRun: true,
    });
    expect(harness.collections.routines.toArray).toHaveLength(0);
    expect(ownBots[0]!.description).toContain("create_draft_reply");
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
it.each(["new-session", "scratch"] as const)(
  "fresh account preserves the explicit %s destination without creating a default bot",
  async (choice) => {
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
        name: choice === "scratch" ? "Start from scratch" : "Say hello",
      })
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: choice === "scratch" ? "New bot" : "New session",
      })
    );
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(
        choice === "scratch" ? "/bots/new" : "/sessions/new"
      )
    );
    expect(harness.collections.bots.toArray).toHaveLength(0);
    expect(harness.collections.routines.toArray).toHaveLength(0);
    expect(
      harness.calls.filter(([name]) => name === "account.skipOnboarding")
    ).toHaveLength(1);
  }
);

it("automatically completing a website signup still creates the sponsored Chief", async () => {
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
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toMatch(/^\/bots\/bot-/)
  );
  expect(harness.collections.bots.toArray).toHaveLength(1);
  expect(harness.collections.bots.toArray[0]).toMatchObject({
    sponsoredFirstRun: true,
  });
  expect(harness.collections.routines.toArray).toHaveLength(0);
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
      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(harness.router.state.location.pathname).toBe(
        "/onboarding/connectors"
      );
      await waitFor(() =>
        expect(
          writes.some(
            (write) => write.platformId === platform && write.enabled === false
          )
        ).toBe(true)
      );
    }
    expect(
      harness.collections.prefs.get("app")?.onboardingPairing ?? []
    ).toEqual([]);
  }
);
