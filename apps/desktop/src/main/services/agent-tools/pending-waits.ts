/**
 * What a session is waiting on the user for, as plain structured state: a
 * connector link not yet connected, a vault page not yet completed, a
 * payment approval not yet given, a checkout paused for the user. The hosted
 * phone lane turns these into its check-in agenda. A wait never carries a
 * link, a vault, request or approval id, or anything anyone typed.
 */
import { randomUUID } from "node:crypto";

import type { CheckoutPause } from "../vault/checkout-run";
import {
  PAYMENT_STEP_HOLD_MS,
  REQUEST_LIFETIME_MS,
  type VaultSession,
} from "../vault/vault-session";

export interface PendingWait {
  /** Stable while the wait lasts; never an id the vault or server gave. */
  itemId: string;
  kind:
    | "connector"
    | "vault_login"
    | "vault_card"
    | "vault_code"
    | "payment"
    | "checkout";
  /** Where it stands: "link_sent", "page_sent", "approval", or what a checkout paused for. */
  stage: string;
  /** The site it is for, as the server or the live page named it. */
  site: string | null;
  /** A payment's payee and total, as the server bound them. */
  merchant?: string;
  amount?: string;
  currency?: string;
  /** A connector's name. */
  label?: string;
  /** Epoch ms it began. */
  since: number;
  /** Epoch ms after which it is no use. */
  expiresAt: number;
}

/** A connector offer stays worth a check-in this long after its link was sent. */
export const CONNECT_OFFER_LIFETIME_MS = 24 * 60 * 60_000;

interface ConnectOffer {
  label: string;
  /** The platform's service key ("gmailuser"): what the server checks it by. */
  service: string;
  since: number;
}

export class PendingWaits {
  /** Connector offers not yet connected, by session, then connector id. */
  private readonly offers = new Map<string, Map<string, ConnectOffer>>();
  /** A vault or checkout wait's own item id and first sighting, by what identifies it. */
  private readonly seen = new Map<string, { itemId: string; since: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The session sent a link or card for these connectors; a resend restarts each one's clock. */
  connectOffered(
    sessionId: string | null,
    connectors: ReadonlyArray<{ id: string; label: string; service: string }>
  ): void {
    if (sessionId == null || connectors.length === 0) return;
    this.prune();
    const offers =
      this.offers.get(sessionId) ?? new Map<string, ConnectOffer>();
    for (const connector of connectors)
      offers.set(connector.id, {
        label: connector.label,
        service: connector.service,
        since: this.now(),
      });
    this.offers.set(sessionId, offers);
  }

  private prune(): void {
    const now = this.now();
    for (const [sessionId, offers] of this.offers) {
      for (const [id, offer] of offers)
        if (offer.since + CONNECT_OFFER_LIFETIME_MS <= now) offers.delete(id);
      if (offers.size === 0) this.offers.delete(sessionId);
    }
  }

  /** Whether the session has connector offers open (worth reading the statuses for). */
  hasOffers(sessionId: string): boolean {
    return (this.offers.get(sessionId)?.size ?? 0) > 0;
  }

  /** These connected, for every session. */
  connectLanded(connectorIds: readonly string[]): void {
    for (const [sessionId, offers] of this.offers) {
      for (const id of connectorIds) offers.delete(id);
      if (offers.size === 0) this.offers.delete(sessionId);
    }
  }

  /**
   * The session's waits, oldest first: its connector offers (`connected`
   * are connected now and dropped) and what its vault state holds open.
   */
  list(
    sessionId: string,
    connected: ReadonlySet<string>,
    vault: VaultSession | null = null
  ): PendingWait[] {
    const waits = [
      ...this.connectorWaits(sessionId, connected),
      ...this.vaultWaits(sessionId, vault),
    ];
    return waits.sort((a, b) => a.since - b.since);
  }

  private connectorWaits(
    sessionId: string,
    connected: ReadonlySet<string>
  ): PendingWait[] {
    const offers = this.offers.get(sessionId);
    if (offers == null) return [];
    const now = this.now();
    const waits: PendingWait[] = [];
    for (const [id, offer] of offers) {
      const expiresAt = offer.since + CONNECT_OFFER_LIFETIME_MS;
      if (connected.has(id) || expiresAt <= now) {
        offers.delete(id);
        continue;
      }
      waits.push({
        itemId: `connect:${offer.service}`,
        kind: "connector",
        stage: "link_sent",
        site: null,
        label: offer.label,
        since: offer.since,
        expiresAt,
      });
    }
    if (offers.size === 0) this.offers.delete(sessionId);
    return waits;
  }

  /**
   * Pages sent and not completed, a payment approval asked for, and a
   * checkout paused for the user. A pause that one of those already covers
   * is the same wait, so it is not listed twice.
   */
  private vaultWaits(
    sessionId: string,
    vault: VaultSession | null
  ): PendingWait[] {
    const live = new Set<string>();
    const waits: PendingWait[] = [];
    const now = this.now();
    if (vault != null) {
      for (const [requestId, request] of vault.requests) {
        if (request.expiresAt <= now) continue;
        const key = `${sessionId}|request|${requestId}`;
        live.add(key);
        waits.push({
          ...this.identity(key),
          kind: `vault_${request.kind}`,
          stage: "page_sent",
          // A login's site; a code's is a saved login, not a site.
          site: request.kind === "login" ? request.site : null,
          expiresAt: request.expiresAt,
        });
      }
      const approval = vault.approval;
      if (approval?.status === "pending" && approval.expiresAt > now) {
        const key = `${sessionId}|approval|${approval.id}`;
        live.add(key);
        waits.push({
          ...this.identity(key),
          kind: "payment",
          stage: "approval",
          site: approval.site,
          merchant: approval.merchant,
          amount: approval.amount,
          currency: approval.currency,
          expiresAt: approval.expiresAt,
        });
      }
      const pause = vault.checkout.paused;
      if (pause != null && waits.length === 0) {
        const key = `${sessionId}|pause|${pause.need}|${pause.site ?? ""}`;
        live.add(key);
        const seen = this.identity(key);
        const expiresAt = seen.since + pauseLifetime(pause);
        if (expiresAt > now)
          waits.push({
            ...seen,
            kind: "checkout",
            stage: pause.need,
            site: pause.site,
            // The total the server bound to the approval, never the page's.
            ...(pause.need === "payment" && approval != null
              ? {
                  merchant: approval.merchant,
                  amount: approval.amount,
                  currency: approval.currency,
                }
              : {}),
            expiresAt,
          });
      }
    }
    // What this session no longer holds is forgotten.
    for (const key of this.seen.keys())
      if (key.startsWith(`${sessionId}|`) && !live.has(key))
        this.seen.delete(key);
    return waits;
  }

  /** The wait's item id and when it was first seen, kept while it lasts. */
  private identity(key: string): { itemId: string; since: number } {
    let seen = this.seen.get(key);
    if (seen == null) {
      seen = { itemId: `wait:${randomUUID().slice(0, 8)}`, since: this.now() };
      this.seen.set(key, seen);
    }
    return seen;
  }
}

/** How long a paused checkout stays worth a check-in: a payment step's hold, else a page's life. */
const pauseLifetime = (pause: CheckoutPause): number =>
  pause.need === "payment" ? PAYMENT_STEP_HOLD_MS : REQUEST_LIFETIME_MS;
