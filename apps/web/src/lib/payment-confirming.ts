/**
 * A payment the platform holds: its gate answers 402 "unconfirmed" for a
 * payment made but not confirmed (an account that never paid is
 * "not_subscribed" and gets a plan instead). Every surface that meets it
 * (the window dialog, the chat's card) shows one shared state instead of a
 * failure: "confirming" while the account is checked every few seconds,
 * "late" once that has gone on for
 * PAYMENT_CONFIRM_WAIT_MS (still checked, in the background, for the checkout
 * link's life), "confirmed" when the gate lets it through.
 */
import { Store, useStore } from "@tanstack/react-store";
import { useEffect, useEffectEvent } from "react";

import type { AppClient } from "#renderer/data/transport/types";

/** How long the app says it is confirming before it says it cannot see the payment yet. */
export const PAYMENT_CONFIRM_WAIT_MS = 5 * 60_000;
const PAYMENT_CONFIRM_POLL_MS = 5_000;
/** The checkout link lives 30 minutes; the watch stops after it. */
const PAYMENT_CONFIRM_LIMIT_MS = 30 * 60_000;

export type PaymentConfirmPhase = "confirming" | "late" | "confirmed";

interface PaymentConfirmState {
  phase: PaymentConfirmPhase | null;
}

export const paymentConfirmStore = new Store<PaymentConfirmState>({
  phase: null,
});

let watch: { check: () => void; stop: () => void } | null = null;

const settle = (phase: PaymentConfirmPhase | null) =>
  paymentConfirmStore.setState(() => ({ phase }));

/**
 * Start (or join) the watch for an unconfirmed payment: the account is asked
 * every few seconds and when the window comes back. Idempotent: every surface
 * may call it, and each reacts to the shared phase.
 */
export const startPaymentConfirmWatch = (client: AppClient): void => {
  if (watch != null) return;
  const started = Date.now();
  let checking = false;
  settle("confirming");
  const late = setTimeout(() => {
    if (paymentConfirmStore.state.phase === "confirming") settle("late");
  }, PAYMENT_CONFIRM_WAIT_MS);
  const check = async () => {
    if (checking) return;
    checking = true;
    const verdict = await client.account
      .payment({ refresh: true })
      .catch(() => undefined);
    checking = false;
    if (watch == null) return;
    if (verdict === null) {
      stop();
      settle("confirmed");
      return;
    }
    if (verdict != null && verdict.reason !== "unconfirmed") {
      // Another gate (no plan, a lapsed plan): not a payment landing, not this watch's.
      stop();
      settle(null);
      return;
    }
    if (Date.now() - started > PAYMENT_CONFIRM_LIMIT_MS) stop();
  };
  const timer = setInterval(() => void check(), PAYMENT_CONFIRM_POLL_MS);
  const onFocus = () => void check();
  window.addEventListener("focus", onFocus);
  const stop = () => {
    clearInterval(timer);
    clearTimeout(late);
    window.removeEventListener("focus", onFocus);
    watch = null;
  };
  watch = { check: () => void check(), stop };
};

/** Ask the account now (Check again). */
export const checkPaymentNow = (): void => watch?.check();

/** For tests and sign-out: forget the watch and its state. */
export const resetPaymentConfirmWatch = (): void => {
  watch?.stop();
  settle(null);
};

export const usePaymentConfirmPhase = (): PaymentConfirmPhase | null =>
  useStore(paymentConfirmStore, (state) => state.phase);

/**
 * A plan screen's re-check: `check` runs every few seconds and when the
 * window comes back, from `since` for the checkout link's life, as the
 * confirm watch does. A payment made anywhere (a checkout the user opened
 * themselves, in the browser) moves them on without Try again. Null: none.
 * `expired` runs once the window is over.
 */
export const usePaymentRecheck = (
  since: number | null,
  check: () => void,
  expired?: () => void
): void => {
  const tick = useEffectEvent(check);
  const over = useEffectEvent(() => expired?.());
  useEffect(() => {
    if (since == null) return;
    const stop = () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    const timer = setInterval(() => {
      if (Date.now() - since > PAYMENT_CONFIRM_LIMIT_MS) {
        stop();
        over();
      } else tick();
    }, PAYMENT_CONFIRM_POLL_MS);
    const onFocus = () => tick();
    window.addEventListener("focus", onFocus);
    return stop;
  }, [since]);
};
