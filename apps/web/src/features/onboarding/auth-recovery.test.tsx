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

it("finishes sign-in when the optional Gmail status lookup fails", async () => {
  const statuses = vi.fn(async () => {
    throw new Error("connector service offline");
  });
  app = await renderApp("/onboarding/welcome", {
    onboarded: false,
    signedIn: false,
    authStart: async () => ({ ok: true }),
    procedures: {
      account: {
        abacus: os.account.abacus.handler(
          () =>
            ({ email: "demo@example.test", subscription_tier: "free" }) as never
        ),
      },
      connectors: { statuses: os.connectors.statuses.handler(statuses) },
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign up for free" })
  );
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe("/onboarding/connected")
  );
  expect(statuses).toHaveBeenCalled();
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

it.each([false, true])(
  "cancel during account refresh prevents a stale handoff, retry=%s",
  async (retry) => {
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
      (transport, intent, profile, callback) =>
        original(transport, intent, profile, async (outcome) => {
          try {
            await callback(outcome);
          } finally {
            finished();
          }
        })
    );
    let refreshing = false;
    let releaseAuth!: (outcome: {
      ok: false;
      cancelled: true;
      error: string;
    }) => void;
    const nextAuth = new Promise<{ ok: false; cancelled: true; error: string }>(
      (resolve) => {
        releaseAuth = resolve;
      }
    );
    const authStart = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementation(() => nextAuth);
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
      expect(app!.router.state.location.pathname).toBe("/onboarding/welcome")
    );
    if (retry) {
      fireEvent.click(
        await screen.findByRole("button", { name: "Sign up for free" })
      );
      await screen.findByRole("button", { name: "Cancel" });
    }
    const currentAttempt = onboardingStore.state.signIn?.id;
    await act(async () => {
      releaseAccount({ email: "demo@example.test", subscription_tier: "free" });
      await settled;
    });
    expect(app.router.state.location.pathname).toBe(
      retry ? "/onboarding/connect" : "/onboarding/welcome"
    );
    expect(connect).not.toHaveBeenCalled();
    expect(onboardingStore.state.signIn?.id).toBe(currentAttempt);
    releaseAuth({ ok: false, cancelled: true, error: "cancelled" });
  }
);
