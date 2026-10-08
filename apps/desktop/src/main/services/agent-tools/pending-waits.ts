/**
 * What a session is waiting on the user for, as plain structured state: a
 * connector link it sent that has not connected. The hosted phone lane turns
 * these into its check-in agenda. A wait never carries a link, a request id
 * or anything the user typed.
 */

export interface PendingWait {
  /** Stable while the wait lasts. */
  itemId: string;
  kind: "connector";
  /** Where it stands, e.g. "link_sent". */
  stage: string;
  site: string | null;
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

  /** The session's waits, oldest first; `connected` are connected now and dropped. */
  list(sessionId: string, connected: ReadonlySet<string>): PendingWait[] {
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
    return waits.sort((a, b) => a.since - b.since);
  }
}
