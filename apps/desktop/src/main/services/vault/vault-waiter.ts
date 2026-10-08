/**
 * Follows what each session sent the user to do on a vault page (save a
 * login or card, enter a code, approve a payment, allow a sign-in) so
 * nothing waits inside a tool call. While anything is outstanding it reads
 * each one's status every few seconds; a page that completed or failed, a
 * payment the user approved and a sign-in they allowed or denied raises one
 * note for the session that asked, and an expired one is dropped. The user saying they are done checks at once (`checkNow`).
 */
import type { VaultClient } from "./vault-client";
import {
  APPROVAL_LIFETIME_MS,
  SIGNIN_LIFETIME_MS,
  SIGNIN_ON_SAVE_LIFETIME_MS,
  type PendingVaultRequest,
  type VaultSession,
  type VaultSessions,
} from "./vault-session";

export interface VaultWaiterDeps {
  client: Pick<
    VaultClient,
    "requestStatus" | "paymentApprovalStatus" | "signinApprovalStatus"
  >;
  sessions: VaultSessions;
  /** A note for the session's model, raised once per outcome. */
  raise: (sessionId: string, note: string) => void;
  everyMs?: number;
  now?: () => number;
}

const WATCH_EVERY_MS = 3_000;

const savedNote = (
  request: PendingVaultRequest,
  itemId: string | null,
  signinAllowed: boolean
): string => {
  const item = itemId != null ? ` (vault item ${itemId})` : "";
  if (request.kind === "login")
    return (
      `[vault] The user saved their login${request.site != null ? ` for ${request.site}` : ""}${item}. ` +
      `To sign in, pass login_item_id ${itemId ?? "(its id from vault_items)"} to browser_task, with continue_from_last when a ` +
      "browser run is paused for this sign-in; its browser fills the username and password itself, and the values never pass through you. " +
      (signinAllowed
        ? "Saving it allowed this first sign-in for the next 10 minutes; a later one needs signin_approval."
        : "Each sign-in with it needs signin_approval first.")
    );
  if (request.kind === "card")
    return (
      `[vault] The user saved a card${item}. ` +
      "It is filled only under a payment they approve: payment_approval at the checkout's review step, with the exact amount."
    );
  return request.forPayment
    ? `[vault] The user entered their bank's code for the approved payment. Have the browser fill it with browser_vault_fill, field "code" and the card's item_id${itemId != null ? ` (${itemId})` : ""}, within a few minutes.`
    : `[vault] The user entered their sign-in code${request.site != null ? ` for ${request.site}` : ""}. Have the browser fill it with browser_vault_fill, field "code"${itemId != null ? ` and item_id ${itemId}` : ""}, within a few minutes.`;
};

const FAILED_NOTE =
  "[vault] Saving on the vault page failed. If it is still needed, send a new link with vault_request.";

const TELL_USER = " Tell the user in one short line, then carry on.";

export class VaultWaiter {
  private timer: NodeJS.Timeout | null = null;
  /** Each session's check in flight; one at a time, so an outcome is reported once. */
  private readonly inflight = new Map<string, Promise<string[]>>();
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
   * new notes instead of raising them. A check already running reports its
   * own outcomes, and this one returns none.
   */
  async checkNow(sessionId: string): Promise<string[]> {
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
        const notes = await this.checkOnce(sessionId, session);
        for (const note of notes) this.deps.raise(sessionId, note);
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
  ): Promise<string[]> {
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

  private async check(session: VaultSession): Promise<string[]> {
    const notes: string[] = [];
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
      if (status.value.status === "completed")
        notes.push(
          savedNote(request, status.value.itemId, signinAllowed) + TELL_USER
        );
      else if (status.value.status === "failed")
        notes.push(FAILED_NOTE + TELL_USER);
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
            notes.push(
              `[vault] The user approved paying ${approval.amount} ${approval.currency} to ${approval.merchant} on ${approval.site} ` +
                `with card ${approval.item}. For the next 10 minutes browser_vault_fill can fill card_number` +
                `${approval.cvvRequired ? " and cvv" : ""} on that checkout, once each.` +
                TELL_USER
            );
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
            notes.push(
              `[vault] The user denied signing in to ${signin.site}. Do not sign in there; ask them how to go on.` +
                TELL_USER
            );
          } else if (status.value.status === "approved") {
            signin.status = "approved";
            signin.expiresAt =
              status.value.expiresAt != null
                ? status.value.expiresAt * 1000
                : this.now() + SIGNIN_LIFETIME_MS;
            notes.push(
              `[vault] The user allowed one sign-in to ${signin.site}. For the next 5 minutes the browser can fill that ` +
                "login's username and password there, once each: call browser_task with login_item_id " +
                `${signin.item} (and continue_from_last when a run is paused for this sign-in).` +
                TELL_USER
            );
          }
        }
      }
    }
    return notes;
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
