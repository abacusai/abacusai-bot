/**
 * Follows what each session sent the user to do on a vault page (save a
 * login or card, enter a code, approve a payment, allow a sign-in) so
 * nothing waits inside a tool call. While anything is outstanding it reads
 * each one's status every few seconds; a page that completed or failed, a
 * payment the user approved and a sign-in they allowed or denied raises one
 * step-done event for the session that asked, and an expired one is dropped. The user saying they are done checks at once (`checkNow`).
 */
import type { StepEvent } from "../session/step-events";
import type { VaultClient } from "./vault-client";
import {
  APPROVAL_LIFETIME_MS,
  SIGNIN_LIFETIME_MS,
  SIGNIN_ON_SAVE_LIFETIME_MS,
  type VaultSession,
  type VaultSessions,
} from "./vault-session";

export interface VaultWaiterDeps {
  client: Pick<
    VaultClient,
    "requestStatus" | "paymentApprovalStatus" | "signinApprovalStatus"
  >;
  sessions: VaultSessions;
  /** A step-done event for the session, raised once per outcome. */
  raise: (sessionId: string, event: StepEvent) => void;
  everyMs?: number;
  now?: () => number;
}

const WATCH_EVERY_MS = 3_000;

export class VaultWaiter {
  private timer: NodeJS.Timeout | null = null;
  /** Each session's check in flight; one at a time, so an outcome is reported once. */
  private readonly inflight = new Map<string, Promise<StepEvent[]>>();
  private readonly now: () => number;

  constructor(private readonly deps: VaultWaiterDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Something new is outstanding: keep checking while anything is. */
  watch(): void {
    this.arm();
  }

  /**
   * Checks the session now (the user said they are done) and returns its
   * new events instead of raising them. A check already running reports its
   * own outcomes, and this one returns none.
   */
  async checkNow(sessionId: string): Promise<StepEvent[]> {
    const session = this.deps.sessions.get(sessionId);
    if (session == null || !session.outstanding()) return [];
    return this.checkOnce(sessionId, session);
  }

  stop(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer != null || this.deps.sessions.waiting().length === 0) return;
    this.timer = setTimeout(
      () => void this.tick(),
      this.deps.everyMs ?? WATCH_EVERY_MS
    );
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      for (const [sessionId, session] of this.deps.sessions.waiting()) {
        const events = await this.checkOnce(sessionId, session);
        for (const event of events) this.deps.raise(sessionId, event);
      }
    } finally {
      // A check that failed or hung never stops the polling.
      this.timer = null;
      this.arm();
    }
  }

  private checkOnce(
    sessionId: string,
    session: VaultSession
  ): Promise<StepEvent[]> {
    const running = this.inflight.get(sessionId);
    if (running != null) return running.then(() => []);
    const check = this.check(session)
      .catch((error: unknown) => {
        console.warn(
          "[vault] status check failed; trying again",
          error instanceof Error ? error.name : "error"
        );
        return [];
      })
      .finally(() => {
        this.inflight.delete(sessionId);
        this.deps.sessions.prune(sessionId);
      });
    this.inflight.set(sessionId, check);
    return check;
  }

  private async check(session: VaultSession): Promise<StepEvent[]> {
    const events: StepEvent[] = [];
    for (const [requestId, request] of session.requests) {
      if (this.now() >= request.expiresAt) {
        session.requests.delete(requestId);
        continue;
      }
      const status = await this.deps.client.requestStatus(requestId);
      if (status.ok === false) continue;
      if (status.value.status === "pending") continue;
      session.requests.delete(requestId);
      const saved = status.value;
      // Saving a login on its page allowed the one sign-in that follows.
      const signinAllowed =
        saved.status === "completed" &&
        saved.signinApprovalId != null &&
        (await this.adoptSavedSignin(
          session,
          saved.signinApprovalId,
          saved.itemId
        ));
      if (saved.status === "completed" || saved.status === "failed")
        events.push({
          event: "vault_saved",
          step: requestId,
          facts:
            saved.status === "failed"
              ? { item_kind: request.kind, outcome: "failed" }
              : {
                  item_kind: request.kind,
                  // A one-time code is held for its fill, never saved.
                  outcome: request.kind === "code" ? "code_received" : "saved",
                  ...(request.site != null ? { site: request.site } : {}),
                  ...(saved.itemId != null ? { item_id: saved.itemId } : {}),
                  for_payment: request.forPayment,
                  signin_allowed: signinAllowed,
                },
        });
    }
    const approval = session.approval;
    if (approval?.status === "pending") {
      if (this.now() >= approval.expiresAt) session.approval = null;
      else {
        const status = await this.deps.client.paymentApprovalStatus(
          approval.id
        );
        // Replaced while the read was out: the new one is checked next time.
        if (status.ok && session.approval === approval) {
          if (status.value.status === "expired") session.approval = null;
          else if (status.value.status === "approved") {
            approval.status = "approved";
            approval.expiresAt = this.now() + APPROVAL_LIFETIME_MS;
            events.push({
              event: "payment_decided",
              step: approval.id,
              facts: {
                decision: "approved",
                amount: approval.amount,
                currency: approval.currency,
                merchant: approval.merchant,
                site: approval.site,
                item_id: approval.item,
                cvv_required: approval.cvvRequired,
              },
            });
          }
        }
      }
    }
    const signin = session.signin;
    if (signin?.status === "pending") {
      if (this.now() >= signin.expiresAt) session.signin = null;
      else {
        const status = await this.deps.client.signinApprovalStatus(signin.id);
        // Replaced while the read was out: the new one is checked next time.
        if (status.ok && session.signin === signin) {
          if (status.value.status === "expired") session.signin = null;
          else if (status.value.status === "denied") {
            session.signin = null;
            events.push({
              event: "signin_decided",
              step: signin.id,
              facts: {
                decision: "denied",
                site: signin.site,
                item_id: signin.item,
              },
            });
          } else if (status.value.status === "approved") {
            signin.status = "approved";
            signin.expiresAt =
              status.value.expiresAt != null
                ? status.value.expiresAt * 1000
                : this.now() + SIGNIN_LIFETIME_MS;
            events.push({
              event: "signin_decided",
              step: signin.id,
              facts: {
                decision: "allowed",
                site: signin.site,
                item_id: signin.item,
              },
            });
          }
        }
      }
    }
    return events;
  }

  /**
   * The sign-in a login's save allowed, held as the session's: bound to the
   * site the server says, not the one the model asked to save for. Whether
   * it was held.
   */
  private async adoptSavedSignin(
    session: VaultSession,
    signinApprovalId: string,
    itemId: string | null
  ): Promise<boolean> {
    if (itemId == null) return false;
    const status =
      await this.deps.client.signinApprovalStatus(signinApprovalId);
    if (
      status.ok === false ||
      status.value.status !== "approved" ||
      status.value.site == null
    )
      return false;
    session.signin = {
      id: signinApprovalId,
      item: itemId,
      site: status.value.site,
      status: "approved",
      used: new Set(),
      expiresAt:
        status.value.expiresAt != null
          ? status.value.expiresAt * 1000
          : this.now() + SIGNIN_ON_SAVE_LIFETIME_MS,
    };
    return true;
  }
}
