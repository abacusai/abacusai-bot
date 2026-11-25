import { afterEach, expect, it, vi } from "vitest";

import type { AppClient } from "#renderer/data/transport/types";
import { signInAbacus } from "#renderer/platform/sign-in.electron";
import { signOutAbacus } from "#renderer/platform/sign-out.electron";
import type { RouterContext } from "#renderer/router";

import {
  claimPaymentSendAgain,
  paymentConfirmStore,
  paymentConfirmedFor,
  resetPaymentConfirmWatch,
  startPaymentConfirmWatch,
} from "./payment-confirming";

afterEach(() => {
  resetPaymentConfirmWatch();
  vi.useRealTimers();
});

const account = (verdict: () => unknown) => {
  const payment = vi.fn(async () => verdict());
  return {
    payment,
    client: { account: { payment } } as unknown as AppClient,
  };
};
const phase = () => paymentConfirmStore.state.phase;

it("five refused turns and the screen share one watch: one account read per tick and per focus", async () => {
  vi.useFakeTimers();
  const { payment, client } = account(() => ({ reason: "not_subscribed" }));
  for (const run of ["r1", "r2", "r3", "r4", "r5"])
    startPaymentConfirmWatch(client, "no_plan", run);
  startPaymentConfirmWatch(client, "no_plan");
  expect(phase()).toBe("no_plan");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(payment).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000 * 4);
  expect(payment).toHaveBeenCalledTimes(5);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(payment).toHaveBeenCalledTimes(6);
});

it("a payment the platform reports held turns no-plan into confirming, then late", async () => {
  vi.useFakeTimers();
  let verdict: unknown = { reason: "not_subscribed" };
  const { client } = account(() => verdict);
  startPaymentConfirmWatch(client, "no_plan", "r1");
  verdict = { reason: "unconfirmed" };
  await vi.advanceTimersByTimeAsync(5_000);
  expect(phase()).toBe("confirming");
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(phase()).toBe("late");
});

it("stops after the checkout link's 30 minutes, and a mount after that reads the account again", async () => {
  vi.useFakeTimers();
  const { payment, client } = account(() => ({ reason: "not_subscribed" }));
  startPaymentConfirmWatch(client, "no_plan", "r1");
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  const stopped = payment.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(payment).toHaveBeenCalledTimes(stopped);
  // The thread is opened again: its card mounts.
  startPaymentConfirmWatch(client, "no_plan", "r1");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(payment).toHaveBeenCalledTimes(stopped + 1);
});

it("a payment that lands is confirmed for the turns that waited: each sends again once, a later refusal starts over", async () => {
  vi.useFakeTimers();
  let verdict: unknown = { reason: "not_subscribed" };
  const { client } = account(() => verdict);
  startPaymentConfirmWatch(client, "no_plan", "r1");
  verdict = null;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(phase()).toBe("confirmed");
  // r1's card comes back (a remount): still confirmed, one send-again.
  startPaymentConfirmWatch(client, "no_plan", "r1");
  expect(paymentConfirmedFor(phase(), "r1")).toBe(true);
  expect(claimPaymentSendAgain("r1")).toBe(true);
  expect(claimPaymentSendAgain("r1")).toBe(false);
  // A turn refused after the payment landed is not that payment's: it starts the watch again.
  verdict = { reason: "not_subscribed" };
  startPaymentConfirmWatch(client, "no_plan", "r9");
  expect(phase()).toBe("no_plan");
  expect(claimPaymentSendAgain("r9")).toBe(false);
});

const signOutContext = () =>
  ({
    transport: {
      client: {
        auth: { abacus: { signOut: async () => {} } },
        account: { signOut: async () => ({}) },
      },
    },
    credentialsChanged: async () => {},
  }) as unknown as RouterContext;

it.each([
  ["sign-out", () => signOutAbacus(signOutContext(), true)],
  [
    "sign-in (an account switch)",
    () =>
      signInAbacus(
        {
          client: { auth: { abacus: { start: async () => ({ ok: true }) } } },
        } as never,
        {}
      ),
  ],
])(
  "account A's watch never carries over to account B: %s resets it",
  async (_name, leave) => {
    vi.useFakeTimers();
    let verdict: unknown = { reason: "not_subscribed" };
    const a = account(() => verdict);
    startPaymentConfirmWatch(a.client, "no_plan", "r1");
    verdict = null;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(phase()).toBe("confirmed");
    await leave();
    expect(phase()).toBeNull();
    expect(claimPaymentSendAgain("r1")).toBe(false);
    // Account B, refused: its own watch, from the start, reading B.
    const b = account(() => ({ reason: "not_subscribed" }));
    startPaymentConfirmWatch(b.client, "no_plan", "r1");
    expect(phase()).toBe("no_plan");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.payment).toHaveBeenCalledTimes(1);
    expect(a.payment).toHaveBeenCalledTimes(1);
  }
);
