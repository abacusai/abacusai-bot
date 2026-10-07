/**
 * Where one session's booking or purchase is, kept beside the vault state
 * that enforces it (`VaultSession`), so the stage, the Pay guard and the
 * approval read one truth:
 *
 *   search → select → details → login? → review → awaiting_approval
 *     → card_fill → bank_otp? → confirmation      (or failed / abandoned)
 *
 * The browser sub-agent moves it with `browser_pause`; the agent's
 * `browser_task` starts, resumes and finishes it through `browser_checkout`.
 * The one move that matters, awaiting_approval → card_fill, happens only
 * when the session holds a live approval for the amount the page showed at
 * the pause; otherwise the run resumes where it was, not approved.
 */
import { sameAmount } from "./vault-fill";
import type { PaymentApproval } from "./vault-session";

export type CheckoutStage =
  | "search"
  | "select"
  | "details"
  | "login"
  | "review"
  | "awaiting_approval"
  | "card_fill"
  | "bank_otp"
  | "confirmation"
  | "failed"
  | "abandoned";

/** What the sub-agent can stop for with `browser_pause`. */
export const PAUSE_NEEDS = [
  "details",
  "login",
  "code",
  "payment",
  "captcha",
  "choose",
] as const;

export type PauseNeed = (typeof PAUSE_NEEDS)[number];

/** A stop: a `browser_pause`, or a run's unstructured "NEEDS USER:" line ("user"). */
export interface CheckoutPause {
  need: PauseNeed | "user";
  /** The fields the user must give (details). */
  fields: string[];
  /** The site the step is on: the live page's host, never the model's word. */
  site: string | null;
  /** For a payment: the total the host read off the page. */
  amount: string | null;
  currency: string | null;
  /** For a payment: who is paid, as the page names them (page text, sanitized). */
  merchant: string | null;
  cvvRequired: boolean;
  /** One or two sentences from the sub-agent (sanitized). */
  summary: string;
  /** A masked screenshot of the page, as a media id, when one was taken. */
  mediaId: string | null;
}

const TERMINAL: ReadonlySet<CheckoutStage> = new Set([
  "confirmation",
  "failed",
  "abandoned",
]);

/**
 * Every move the run may make. Staying put is always allowed for a live
 * stage and is not listed; failed and abandoned are reachable from any.
 */
export const CHECKOUT_TRANSITIONS: Readonly<
  Record<CheckoutStage, readonly CheckoutStage[]>
> = {
  search: ["select", "details", "login", "review"],
  select: ["details", "login", "review"],
  details: ["login", "review"],
  login: ["details", "review"],
  // Back to details when the review shows a detail to fix.
  review: ["details", "awaiting_approval"],
  // Back to review when the total changed before it was approved.
  awaiting_approval: ["review", "card_fill"],
  card_fill: ["bank_otp", "confirmation", "review"],
  bank_otp: ["confirmation"],
  confirmation: [],
  failed: [],
  abandoned: [],
};

export const isTerminalStage = (stage: CheckoutStage): boolean =>
  TERMINAL.has(stage);

/** Whether the run may go from `from` to `to`. */
export function canMove(from: CheckoutStage, to: CheckoutStage): boolean {
  if (isTerminalStage(from)) return false;
  if (from === to) return true;
  if (to === "failed" || to === "abandoned") return true;
  return CHECKOUT_TRANSITIONS[from].includes(to);
}

export type CheckoutVerdict =
  | { ok: true; stage: CheckoutStage }
  | { ok: false; reason: string };

/** Before the payment: the user's details, sign-in and choices. */
const BEFORE_PAYMENT: ReadonlySet<CheckoutStage> = new Set([
  "search",
  "select",
  "details",
  "login",
  "review",
]);

/** The stages from the payment approval on. */
const PAST_REVIEW: ReadonlySet<CheckoutStage> = new Set([
  "awaiting_approval",
  "card_fill",
  "bank_otp",
]);

/** How a run that did not pause ended, as `browser_task` reports it. */
export type RunEnd =
  | "completed"
  | "turn-limit"
  | "timeout"
  | "error"
  | "provider-error"
  | "aborted";

export class CheckoutRun {
  private current: CheckoutStage = "search";
  private held: CheckoutPause | null = null;

  get stage(): CheckoutStage {
    return this.current;
  }

  /** The stop the run is waiting on the user for, if any. */
  get paused(): CheckoutPause | null {
    return this.held;
  }

  /** Past search: a checkout is under way (the browser runs no scripts). */
  pastSearch(): boolean {
    return this.current !== "search" && !isTerminalStage(this.current);
  }

  /** At or past the payment approval: every activation is guarded. */
  pastReview(): boolean {
    return PAST_REVIEW.has(this.current);
  }

  /** Whether anything is under way that a pruned session would lose. */
  active(): boolean {
    return this.held != null || this.pastSearch();
  }

  /** A new run: whatever was under way is let go. */
  start(): void {
    this.current = "search";
    this.held = null;
  }

  /**
   * The stage a pause for `need` puts the run in, or why it may not pause
   * for that here. Pure: nothing moves until `pause`.
   */
  pauseTarget(need: CheckoutPause["need"]): CheckoutVerdict {
    const from = this.current;
    if (isTerminalStage(from))
      return { ok: false, reason: `The checkout is over (${from}).` };
    if (this.held != null)
      return { ok: false, reason: "The run is already paused for the user." };
    const stay: CheckoutVerdict = { ok: true, stage: from };
    switch (need) {
      case "user":
      case "captcha":
        return from === "awaiting_approval"
          ? {
              ok: false,
              reason: "The run is waiting for the payment approval.",
            }
          : stay;
      case "choose":
        if (from === "search") return { ok: true, stage: "select" };
        return BEFORE_PAYMENT.has(from)
          ? stay
          : {
              ok: false,
              reason:
                "Choices are made before the payment; the payment step is past that.",
            };
      case "details":
      case "login":
        return BEFORE_PAYMENT.has(from) && canMove(from, need)
          ? { ok: true, stage: need }
          : {
              ok: false,
              reason: `A ${need} step comes before the review, and the run is at ${from}.`,
            };
      case "code":
        // During the payment it is the bank's code; before it, a sign-in code.
        if (from === "card_fill" || from === "bank_otp")
          return { ok: true, stage: "bank_otp" };
        return BEFORE_PAYMENT.has(from) && canMove(from, "login")
          ? { ok: true, stage: "login" }
          : {
              ok: false,
              reason: `A code is asked for at sign-in or by the bank during the payment, and the run is at ${from}.`,
            };
      case "payment":
        // The review, then the approval: a run that reaches the total from
        // search or details passes through the review on the way.
        return from === "review" || canMove(from, "review")
          ? { ok: true, stage: "awaiting_approval" }
          : {
              ok: false,
              reason: `The payment is approved at the review, and the run is at ${from}.`,
            };
    }
  }

  /** Stops the run for the user, moving it to the stage the pause belongs to. */
  pause(request: CheckoutPause): CheckoutVerdict {
    const target = this.pauseTarget(request.need);
    if (target.ok === false) return target;
    this.current = target.stage;
    this.held = request;
    return target;
  }

  /**
   * The user has done their part and the run continues. A run waiting for the
   * approval moves to the card fill only when `approval` is live and for the
   * total the page showed at the pause; otherwise it stays waiting, and
   * `approved` says so. Every other stop carries on in place.
   */
  resume(approval: PaymentApproval | null):
    | { ok: true; stage: CheckoutStage; approved: boolean }
    | {
        ok: false;
        reason: string;
      } {
    if (isTerminalStage(this.current))
      return { ok: false, reason: `The checkout is over (${this.current}).` };
    const held = this.held;
    if (held == null)
      return { ok: false, reason: "Nothing is paused to continue." };
    this.held = null;
    if (this.current === "awaiting_approval") {
      if (!approvalMatches(approval, held))
        return { ok: true, stage: this.current, approved: false };
      this.current = "card_fill";
    }
    return {
      ok: true,
      stage: this.current,
      approved: this.current === "card_fill" || this.current === "bank_otp",
    };
  }

  /** How a run that did not pause ended. */
  finish(end: RunEnd): void {
    if (this.held != null || isTerminalStage(this.current)) return;
    if (end === "aborted") this.current = "abandoned";
    else if (end === "error" || end === "provider-error")
      this.current = "failed";
    else if (
      end === "completed" &&
      (this.current === "card_fill" || this.current === "bank_otp")
    )
      this.current = "confirmation";
  }

  /** Let go: it waited too long, or the user moved on. */
  abandon(): void {
    if (isTerminalStage(this.current)) return;
    this.held = null;
    this.current = "abandoned";
  }
}

/** Whether `approval` is the user's yes to the payment `pause` stopped for. */
export function approvalMatches(
  approval: PaymentApproval | null,
  pause: CheckoutPause
): boolean {
  return (
    approval != null &&
    approval.status === "approved" &&
    pause.need === "payment" &&
    pause.amount != null &&
    pause.currency != null &&
    sameAmount(approval.amount, pause.amount) &&
    approval.currency === pause.currency
  );
}
