import { describe, expect, it } from "vitest";

import {
  canMove,
  CHECKOUT_TRANSITIONS,
  CheckoutRun,
  type CheckoutPause,
  type CheckoutStage,
} from "./checkout-run";
import {
  type PaymentApproval,
  PAYMENT_STEP_HOLD_MS,
  VaultSessions,
} from "./vault-session";

const pause = (
  need: CheckoutPause["need"],
  extra: Partial<CheckoutPause> = {}
): CheckoutPause => ({
  need,
  fields: [],
  site: null,
  amount: null,
  currency: null,
  merchant: null,
  cvvRequired: false,
  summary: "stopped",
  mediaId: null,
  ...extra,
});

const PAYMENT = pause("payment", { amount: "1234.00", currency: "INR" });

const approval = (over: Partial<PaymentApproval> = {}): PaymentApproval => ({
  id: "pay-1",
  item: "card-1",
  merchant: "Akasa Air",
  amount: "1234.00",
  currency: "INR",
  site: "akasaair.com",
  cvvRequired: false,
  status: "approved",
  used: new Set(),
  codeOrigin: null,
  expiresAt: Date.now() + 60_000,
  ...over,
});

/** Pauses for `need` and resumes without an approval. */
const step = (run: CheckoutRun, need: CheckoutPause["need"]) => {
  const paused = run.pause(pause(need));
  const resumed = run.resume(null);
  return { paused, resumed };
};

describe("the checkout's stages", () => {
  it("walks a whole booking: search, select, details, login, approval, card, bank code, confirmation", () => {
    const run = new CheckoutRun();
    expect(run.stage).toBe("search");
    expect(step(run, "choose").paused).toEqual({ ok: true, stage: "select" });
    expect(step(run, "details").paused).toEqual({ ok: true, stage: "details" });
    expect(step(run, "login").paused).toEqual({ ok: true, stage: "login" });

    expect(run.pause(PAYMENT)).toEqual({
      ok: true,
      stage: "awaiting_approval",
    });
    expect(run.pastReview()).toBe(true);
    expect(run.resume(approval())).toEqual({
      ok: true,
      stage: "card_fill",
      approved: true,
    });

    // A code during the payment is the bank's.
    expect(run.pause(pause("code"))).toEqual({ ok: true, stage: "bank_otp" });
    expect(run.resume(approval()).ok).toBe(true);
    expect(run.stage).toBe("bank_otp");

    run.finish("completed");
    expect(run.stage).toBe("confirmation");
  });

  it("stays waiting on a resume without a live approval of the paused total", () => {
    for (const given of [
      null,
      approval({ status: "pending" }),
      approval({ amount: "1300.00" }),
      approval({ currency: "USD" }),
    ]) {
      const run = new CheckoutRun();
      run.pause(PAYMENT);
      expect(run.resume(given)).toEqual({
        ok: true,
        stage: "awaiting_approval",
        approved: false,
      });
      // The run is no longer held: it may stop for the payment again.
      expect(run.pause(PAYMENT).ok).toBe(true);
    }
  });

  it("treats a code before the payment as a sign-in code", () => {
    const run = new CheckoutRun();
    expect(run.pause(pause("code"))).toEqual({ ok: true, stage: "login" });
  });

  it("refuses details, a login or a choice once the payment has started", () => {
    const run = new CheckoutRun();
    run.pause(PAYMENT);
    run.resume(approval());
    expect(run.stage).toBe("card_fill");
    for (const need of ["details", "login", "choose"] as const)
      expect(run.pauseTarget(need).ok).toBe(false);
  });

  it("goes back to the approval when the total changes during the card fill", () => {
    const run = new CheckoutRun();
    run.pause(PAYMENT);
    run.resume(approval());
    expect(run.pause(PAYMENT)).toEqual({
      ok: true,
      stage: "awaiting_approval",
    });
  });

  it("keeps a CAPTCHA at the stage it interrupted", () => {
    const run = new CheckoutRun();
    step(run, "details");
    expect(run.pause(pause("captcha"))).toEqual({ ok: true, stage: "details" });
  });

  it("refuses a second pause while one is held, and a resume with nothing paused", () => {
    const run = new CheckoutRun();
    expect(run.resume(null).ok).toBe(false);
    run.pause(pause("details"));
    expect(run.pause(pause("login")).ok).toBe(false);
    expect(run.resume(null).ok).toBe(true);
    expect(run.resume(null).ok).toBe(false);
  });

  it("ends failed on an error and abandoned when stopped or let go, and refuses everything after", () => {
    const failed = new CheckoutRun();
    failed.finish("provider-error");
    expect(failed.stage).toBe("failed");
    expect(failed.pauseTarget("details").ok).toBe(false);

    const stopped = new CheckoutRun();
    stopped.finish("aborted");
    expect(stopped.stage).toBe("abandoned");

    const letGo = new CheckoutRun();
    letGo.pause(PAYMENT);
    letGo.abandon();
    expect(letGo.stage).toBe("abandoned");
    expect(letGo.paused).toBeNull();
    expect(letGo.resume(approval()).ok).toBe(false);
    letGo.start();
    expect(letGo.stage).toBe("search");
  });

  it("says when a checkout is under way: past search, past review", () => {
    const run = new CheckoutRun();
    expect(run.pastSearch()).toBe(false);
    step(run, "details");
    expect(run.pastSearch()).toBe(true);
    expect(run.pastReview()).toBe(false);
  });

  it("allows no move out of a finished checkout, and none into the card fill but from the approval", () => {
    for (const stage of ["confirmation", "failed", "abandoned"] as const)
      expect(canMove(stage, "search")).toBe(false);
    const beforeApproval: CheckoutStage[] = [
      "search",
      "select",
      "details",
      "login",
      "review",
    ];
    for (const stage of beforeApproval) {
      expect(canMove(stage, "card_fill")).toBe(false);
      expect(canMove(stage, "confirmation")).toBe(false);
    }
    const intoCardFill = Object.entries(CHECKOUT_TRANSITIONS)
      .filter(([, next]) => next.includes("card_fill"))
      .map(([from]) => from);
    expect(intoCardFill).toEqual(["awaiting_approval"]);
  });
});

describe("payment steps remembered beside the checkout", () => {
  it("outlive a checkout back at search, for the hold window, and keep the session from being pruned", () => {
    let now = 1_000;
    const sessions = new VaultSessions(() => now);
    const session = sessions.for("s1");
    session.notePaymentStep("https://shop.example");
    sessions.prune("s1");
    expect(sessions.get("s1")).toBe(session);
    expect(session.isPaymentStep("https://shop.example")).toBe(true);

    now += PAYMENT_STEP_HOLD_MS + 1;
    expect(session.isPaymentStep("https://shop.example")).toBe(false);
    sessions.prune("s1");
    expect(sessions.get("s1")).toBeNull();
  });

  it("are kept by a new run while the tab is still on one, and forgotten otherwise", () => {
    const session = new VaultSessions().for("s1");
    session.notePaymentStep("https://shop.example");
    session.forgetPaymentSteps("https://shop.example");
    expect(session.isPaymentStep("https://shop.example")).toBe(true);
    session.forgetPaymentSteps("https://elsewhere.example");
    expect(session.isPaymentStep("https://shop.example")).toBe(false);
  });
});
