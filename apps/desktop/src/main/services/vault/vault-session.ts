import { CheckoutRun } from "./checkout-run";
import type { VaultField } from "./vault-client";

/**
 * What one agent session has outstanding with the vault: the one-time pages
 * it sent, the payment approval it asked for, and the approval the user
 * granted. The ids live here and only here: the tools never take a request
 * or approval id from the model, so it cannot name one it was not given.
 */

/** A one-time page the session sent, until it completes, fails or expires. */
export interface PendingVaultRequest {
  requestId: string;
  kind: "login" | "card" | "code";
  /** The site a login is for; the login a sign-in code is for. */
  site: string | null;
  itemId: string | null;
  /** Set for a bank's code: the payment it belongs to. */
  forPayment: boolean;
  /** Epoch ms after which the page is gone. */
  expiresAt: number;
}

/** A payment approval the session asked for, pending or granted. */
export interface PaymentApproval {
  id: string;
  /** The card it is for. */
  item: string;
  merchant: string;
  /** Exactly as the server bound it. */
  amount: string;
  currency: string;
  /** The checkout's registrable domain, as the server bound it. */
  site: string;
  cvvRequired: boolean;
  status: "pending" | "approved";
  /** The card fields filled (or being filled) under it: each is filled once. */
  used: Set<VaultField>;
  /** The origin the bank's code was asked for on; the code is typed only there. */
  codeOrigin: string | null;
  /** Epoch ms after which it is no use: the page's life while pending, the approval's once granted. */
  expiresAt: number;
}

/** How long a granted approval lets cards be filled (the server's own bound). */
export const APPROVAL_LIFETIME_MS = 10 * 60_000;
/** A page whose expiry the server did not say lives this long (the server's own). */
export const REQUEST_LIFETIME_MS = 30 * 60_000;

export class VaultSession {
  readonly requests = new Map<string, PendingVaultRequest>();
  /** The session's one payment approval: a new one replaces the last. */
  approval: PaymentApproval | null = null;
  /** The session's booking or purchase, moved by its browser run. */
  readonly checkout = new CheckoutRun();
  /**
   * Origins the browser saw as a payment step, with when it last saw each:
   * they stay guarded for the checkout's hold window, whatever the stage.
   */
  private readonly paymentSteps = new Map<string, number>();
  /**
   * What the Pay guard let through under each approval: the payment (which
   * spends it), the one step from the review toward it, the bank's code
   * submit. Taken synchronously the moment the guard decides, so two
   * activations racing on one approval cannot both pass.
   */
  readonly committed = new Map<
    string,
    { paid: boolean; reviewed: boolean; bankSubmitted: boolean }
  >();
  /**
   * The element showing the checkout total, as the browser chose it: at the
   * payment pause, and again by a card fill whose total it checked against
   * the approval. A commit re-reads this one; a model cannot name another.
   */
  anchoredTotal: { selector: string; frameId: string | null } | null = null;
  /**
   * The site saved travelers may fill on: the registrable domain of the
   * details stop the user answered (it was named to them in the question).
   */
  checkoutSite: string | null = null;

  constructor(private readonly now: () => number) {}

  /** The approval the user granted, while it is good. */
  approved(): PaymentApproval | null {
    const approval = this.approval;
    if (approval?.status !== "approved") return null;
    if (this.now() >= approval.expiresAt) {
      this.approval = null;
      return null;
    }
    return approval;
  }

  /** Whether anything is waiting on the user. */
  outstanding(): boolean {
    return this.requests.size > 0 || this.approval?.status === "pending";
  }

  /** The origin is a payment step; remembered for the hold window. */
  notePaymentStep(origin: string): void {
    this.paymentSteps.set(origin, this.now());
  }

  /** Whether the origin was seen as a payment step within the hold window. */
  isPaymentStep(origin: string | null): boolean {
    if (origin == null) return false;
    const seen = this.paymentSteps.get(origin);
    if (seen == null) return false;
    if (this.now() - seen > PAYMENT_STEP_HOLD_MS) {
      this.paymentSteps.delete(origin);
      return false;
    }
    return true;
  }

  /** Whether any origin is still remembered as a payment step. */
  rememberedPaymentSteps(): boolean {
    for (const origin of Array.from(this.paymentSteps.keys()))
      if (this.isPaymentStep(origin)) return true;
    return false;
  }

  /** Forgets the remembered payment steps, unless the tab is on one now. */
  forgetPaymentSteps(currentOrigin: string | null): void {
    if (this.isPaymentStep(currentOrigin)) return;
    this.paymentSteps.clear();
  }
}

/** How long a payment step stays guarded after it was last seen: a paused run's hold. */
export const PAYMENT_STEP_HOLD_MS = 45 * 60_000;

/** The vault state of every session that has any. */
export class VaultSessions {
  private readonly sessions = new Map<string, VaultSession>();

  constructor(private readonly now: () => number = Date.now) {}

  for(sessionId: string): VaultSession {
    let session = this.sessions.get(sessionId);
    if (session == null) {
      session = new VaultSession(this.now);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  get(sessionId: string): VaultSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** The sessions that have something waiting on the user. */
  waiting(): Array<[string, VaultSession]> {
    return [...this.sessions].filter(([, session]) => session.outstanding());
  }

  /** Lets go of a session that has nothing left. */
  prune(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (
      session != null &&
      !session.outstanding() &&
      session.approved() == null &&
      !session.checkout.active() &&
      !session.rememberedPaymentSteps()
    )
      this.sessions.delete(sessionId);
  }
}
