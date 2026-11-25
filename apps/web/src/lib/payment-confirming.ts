/**
 * The account's payment, watched until it lands: one shared watch for every
 * surface that meets the payment gate (the window dialog, the onboarding
 * step, the chat's cards), so the account is read once every few seconds
 * whoever shows it. It starts from what the surface saw:
 *
 * - "confirming": a payment the platform holds (402 "unconfirmed"), then
 *   "late" once that has gone on for PAYMENT_CONFIRM_WAIT_MS;
 * - "no_plan": an account that never paid (402 "not_subscribed", or a reason
 *   this build does not know). A payment made anywhere, in a checkout the
 *   app opened or not, lands while it shows; one the platform reports as held
 *   turns it into "confirming".
 *
 * It is still checked, in the background, for the checkout link's life, and
 * "confirmed" when the gate lets the account through, which every later
 * mount reads until a sign-in or sign-out resets it.
 */
import { Store, useStore } from "@tanstack/react-store";

import type { AppClient } from "#renderer/data/transport/types";

/** How long the app says it is confirming before it says it cannot see the payment yet. */
export const PAYMENT_CONFIRM_WAIT_MS = 5 * 60_000;
const PAYMENT_CONFIRM_POLL_MS = 5_000;
/** The checkout link lives 30 minutes; the watch stops after it. */
const PAYMENT_CONFIRM_LIMIT_MS = 30 * 60_000;

export type PaymentConfirmPhase =
  | "no_plan"
  | "confirming"
  | "late"
  | "confirmed";

interface PaymentConfirmState {
  phase: PaymentConfirmPhase | null;
}

export const paymentConfirmStore = new Store<PaymentConfirmState>({
  phase: null,
});

let watch: { check: () => void; stop: () => void } | null = null;
/** Refused turns that waited on this watch: theirs is the payment a "confirmed" lands. */
const waitingRuns = new Set<string>();
/** Turns whose waiting message was sent again: once each. */
const resentRuns = new Set<string>();

const settle = (phase: PaymentConfirmPhase | null) =>
  paymentConfirmStore.setState(() => ({ phase }));

/** The reasons another gate refuses for (a trial or a plan that ended): not this watch's. */
const otherGate = (reason: string | null): boolean =>
  reason === "trial_ended" || reason === "lapsed";

/**
 * Start (or join) the watch: the account is asked every few seconds and when
 * the window comes back. Idempotent: every surface may call it, and each
 * reacts to the shared phase. `runId`, a refused turn's card: a turn whose
 * payment this watch already confirmed keeps "confirmed"; a turn refused
 * after it starts the watch again.
 */
export const startPaymentConfirmWatch = (
  client: AppClient,
  from: "confirming" | "no_plan" = "confirming",
  runId?: string
): void => {
  if (runId != null) {
    if (
      paymentConfirmStore.state.phase === "confirmed" &&
      waitingRuns.has(runId)
    )
      return;
    waitingRuns.add(runId);
  }
  if (watch != null) return;
  const started = Date.now();
  let checking = false;
  let late: ReturnType<typeof setTimeout> | undefined;
  const confirming = () => {
    settle("confirming");
    clearTimeout(late);
    late = setTimeout(() => {
      if (paymentConfirmStore.state.phase === "confirming") settle("late");
    }, PAYMENT_CONFIRM_WAIT_MS);
  };
  if (from === "confirming") confirming();
  else settle("no_plan");
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
    if (verdict != null && otherGate(verdict.reason)) {
      // Another gate (a lapsed plan): not a payment landing, not this watch's.
      stop();
      settle(null);
      return;
    }
    const phase = paymentConfirmStore.state.phase;
    if (verdict?.reason === "unconfirmed") {
      // Paid, and held: confirming from now, never a second purchase.
      if (phase === "no_plan") confirming();
    } else if (verdict != null && phase !== "no_plan") {
      clearTimeout(late);
      settle("no_plan");
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

/** Whether the payment `runId` waited on has landed (its card goes, its message is sent again). */
export const paymentConfirmedFor = (
  phase: PaymentConfirmPhase | null,
  runId: string
): boolean => phase === "confirmed" && waitingRuns.has(runId);

/** True once per turn whose payment landed: its one send-again. */
export const claimPaymentSendAgain = (runId: string): boolean => {
  if (!paymentConfirmedFor(paymentConfirmStore.state.phase, runId))
    return false;
  if (resentRuns.has(runId)) return false;
  resentRuns.add(runId);
  return true;
};

/** On sign-in, sign-out and in tests: forget the watch and its state. */
export const resetPaymentConfirmWatch = (): void => {
  watch?.stop();
  settle(null);
  waitingRuns.clear();
  resentRuns.clear();
};

export const usePaymentConfirmPhase = (): PaymentConfirmPhase | null =>
  useStore(paymentConfirmStore, (state) => state.phase);
