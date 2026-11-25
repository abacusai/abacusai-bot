import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

it("Sign out on the shell's payment screen signs out as the profile menu does", async () => {
  let signedIn = true;
  const signOut = vi.fn(() => {
    signedIn = false;
    return { stashedSessions: 0, removedProviders: [] };
  });
  app = await renderApp("/", {
    procedures: {
      auth: { abacus: { signOut: os.auth.abacus.signOut.handler(signOut) } },
      account: {
        payment: os.account.payment.handler(() =>
          signedIn ? { reason: "lapsed" } : null
        ),
        signOut: os.account.signOut.handler(() => ({
          account: null,
          apps: [],
          onboarded: true,
        })),
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

  await waitFor(() =>
    expect(document.querySelector('[data-slot="payment-required"]')).toBeNull()
  );
  expect(signOut).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ input: { keepOtherApiKeys: true } })
  );
});

const DIALOG_SCREENS = [
  { reason: "unconfirmed", title: "Confirming your payment…", cta: null },
  {
    reason: "not_subscribed",
    title: "Choose a plan to keep using AbacusAI Bot",
    cta: "Upgrade",
  },
  // A server that sends no reason, or one this build does not know.
  {
    reason: null,
    title: "Choose a plan to keep using AbacusAI Bot",
    cta: "Upgrade",
  },
  { reason: "trial_ended", title: "Your free trial has ended", cta: "Upgrade" },
  { reason: "lapsed", title: "Your subscription has ended", cta: "Renew" },
] as const;

it.each(DIALOG_SCREENS)(
  "the shell's payment screen for $reason is $title",
  async ({ reason, title, cta }) => {
    app = await renderApp("/", {
      procedures: {
        account: {
          payment: os.account.payment.handler(
            () => (reason != null ? { reason } : { reason: null }) as never
          ),
        },
      },
    });
    expect(await screen.findByRole("heading", { name: title })).not.toBeNull();
    if (cta == null)
      expect(
        screen.queryByRole("button", { name: /Upgrade|Renew/ })
      ).toBeNull();
    else {
      expect(screen.getByRole("button", { name: cta })).not.toBeNull();
      expect(screen.queryByText("Confirming your payment…")).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Sign out" })).not.toBeNull();
  },
  30_000
);

it("checkout opened from the no-plan screen waits for it, then goes on once the payment lands", async () => {
  let verdict: { reason: string } | null = { reason: "not_subscribed" };
  const payment = vi.fn(() => verdict as never);
  app = await renderApp("/", {
    procedures: {
      account: { payment: os.account.payment.handler(payment) },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Upgrade" }));
  await screen.findByText(
    "Finish checkout in your browser. The app continues as soon as your payment goes through."
  );
  expect(screen.queryByText("Confirming your payment…")).toBeNull();
  verdict = null;
  window.dispatchEvent(new Event("focus"));
  await waitFor(() =>
    expect(document.querySelector('[data-slot="payment-required"]')).toBeNull()
  );
}, 30_000);
