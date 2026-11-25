import type { AbacusPaymentRequired } from "@abacus-ai/contract/contracts";
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
export const PAYMENT_CONFIRM_LIMIT_MS = 30 * 60_000;

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
  recheckRun?.stop();
  recheckKeys.clear();
  recheckUntil = 0;
  turnVerdicts.clear();
  turnsSentAgain.clear();
};

export const usePaymentConfirmPhase = (): PaymentConfirmPhase | null =>
  useStore(paymentConfirmStore, (state) => state.phase);

type PaymentVerdict = AbacusPaymentRequired | null;

/** Who hears the shared re-check's verdicts: the no-plan screen and every no-plan chat card on screen. */
const recheckListeners = new Set<(verdict: PaymentVerdict) => void>();
/** What has already opened a re-check window: a remount never opens another. */
const recheckKeys = new Set<string>();
let recheckUntil = 0;
let recheckRun: { stop: () => void } | null = null;

/**
 * The one re-check for an account with no plan, shared like the confirm
 * watch: one account read every few seconds and on focus, whoever listens,
 * and one checkout link's life (30 minutes) from the first `key` that asked.
 * A new `key` (a checkout opened, a new refused turn) opens a fresh window; a
 * key already seen (a remount) does not. It stops once nobody listens, the
 * window ends, the payment lands, or the platform says it holds the payment
 * (the confirm watch takes over from there).
 */
const startPaymentRecheck = (client: AppClient, key: string): void => {
  if (!recheckKeys.has(key)) {
    recheckKeys.add(key);
    recheckUntil = Date.now() + PAYMENT_CONFIRM_LIMIT_MS;
  }
  if (recheckRun != null || Date.now() >= recheckUntil) return;
  let checking = false;
  const check = async () => {
    if (checking) return;
    if (Date.now() >= recheckUntil) {
      stop();
      return;
    }
    checking = true;
    const verdict = await client.account
      .payment({ refresh: true })
      .catch(() => undefined);
    checking = false;
    if (verdict === undefined || recheckRun !== run) return;
    if (verdict === null || verdict.reason === "unconfirmed") {
      // Settled: a remount must not open the window again. A new key may.
      recheckUntil = 0;
      stop();
    }
    for (const listener of Array.from(recheckListeners)) listener(verdict);
  };
  const timer = setInterval(() => void check(), PAYMENT_CONFIRM_POLL_MS);
  const onFocus = () => void check();
  window.addEventListener("focus", onFocus);
  const stop = () => {
    clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    if (recheckRun === run) recheckRun = null;
  };
  const run = { stop };
  recheckRun = run;
};

/** What the re-check settled for a refused turn's card, kept across remounts. */
const turnVerdicts = new Map<string, "landed" | "held">();
/** Turns whose waiting message was already sent again. */
const turnsSentAgain = new Set<string>();

export const turnPaymentVerdict = (runId: string): "landed" | "held" | null =>
  turnVerdicts.get(runId) ?? null;

export const noteTurnPaymentVerdict = (
  runId: string,
  verdict: "landed" | "held"
): void => {
  turnVerdicts.set(runId, verdict);
};

/** True once per turn: the one send-again a landed payment allows. */
export const claimTurnSendAgain = (runId: string): boolean => {
  if (turnsSentAgain.has(runId)) return false;
  turnsSentAgain.add(runId);
  return true;
};

/**
 * Listen to the shared no-plan re-check while `key` is set (null: not
 * listening). `heard` gets each verdict: null once the payment lands.
 */
export const usePaymentRecheck = (
  client: AppClient,
  key: string | null,
  heard: (verdict: PaymentVerdict) => void
): void => {
  const onVerdict = useEffectEvent(heard);
  useEffect(() => {
    if (key == null) return;
    const listener = (verdict: PaymentVerdict) => onVerdict(verdict);
    recheckListeners.add(listener);
    startPaymentRecheck(client, key);
    return () => {
      recheckListeners.delete(listener);
      if (recheckListeners.size === 0) recheckRun?.stop();
    };
  }, [client, key]);
};
