import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { onboardingStore } from "./store";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
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
