/**
 * Follows connectors a link or card was offered for until they connect, so
 * nothing has to wait inside a tool call. One status read per tick covers
 * every offer; an offer is reported once, with whichever of its connectors
 * connected and whichever its consent did not grant (one Google consent lands
 * several together, and the user can untick some), and is given up when its
 * link expires.
 *
 * An offer made with a link is judged by that link alone while the server
 * reports on it: not completed means keep waiting, completed is the outcome.
 * Only when the server cannot say does the offer fall back to the statuses,
 * where a consent that landed some of its connectors is given a moment for the
 * rest before they count as not granted. A reconnect (every connector already
 * connected) is judged by its link only: the statuses would read as landed.
 */
import type { ConnectorStatuses } from "@abacus-ai/contract/contracts";

export interface ConnectedOffer {
  /** The session that asked, told once it lands; null for none. */
  sessionId: string | null;
  connectorIds: string[];
  /** Offered, but not granted by the consent that connected the rest. */
  notGranted: string[];
  /** Who each connected as, when the platform says. */
  accounts: Record<string, string>;
}

/** A link's completion, in connector ids; null when the server cannot say. */
export type LinkOutcome = {
  completed: boolean;
  connected: string[];
  notGranted: string[];
} | null;

interface ConnectWatcherDeps {
  list: () => Promise<ConnectorStatuses>;
  /** What the offer's link has done, read when an offer carries one. */
  linkStatus?: (requestId: string) => Promise<LinkOutcome>;
  connected: (offer: ConnectedOffer) => void;
  /** The offer's link expired unconnected. */
  expired: (connectorIds: string[]) => void;
  everyMs?: number;
  /** How long a link stays good. */
  forMs?: number;
  /** How long a partly landed offer waits for the rest of one consent. */
  settleMs?: number;
  now?: () => number;
}

const WATCH_EVERY_MS = 5_000;
const WATCH_FOR_MS = 30 * 60_000;
// One consent saves every member it granted in one request; the rest of it
// lands well within this.
const SETTLE_MS = 15_000;

interface Landed {
  connected: string[];
  notGranted: string[];
}

/** What the offer's link says: its outcome, still open, or nothing to go by. */
type LinkState =
  | { kind: "completed"; landed: Landed }
  | { kind: "pending" }
  | { kind: "unavailable" };

interface Offer {
  connectorIds: string[];
  sessionId: string | null;
  requestId?: string;
  /** Judged by its link alone, never the statuses: a reconnect. */
  byLinkOnly: boolean;
  /** The server could not say once; the statuses judge it from then on. */
  linkUnavailable: boolean;
  until: number;
  /** When some, not all, of its connectors were first seen connected. */
  partlySince?: number;
}

export class ConnectWatcher {
  private readonly offers = new Map<string, Offer>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ConnectWatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The same connectors offered to the same session again restart its clock. */
  watch(input: {
    connectorIds: string[];
    sessionId: string | null;
    requestId?: string;
    byLinkOnly?: boolean;
  }): void {
    if (input.connectorIds.length === 0) return;
    // Nothing would ever tell a link-only offer without a link that it landed.
    if (input.byLinkOnly === true && input.requestId == null) return;
    const key = `${[...input.connectorIds].sort().join(",")}|${input.sessionId ?? ""}`;
    this.offers.set(key, {
      connectorIds: input.connectorIds,
      sessionId: input.sessionId,
      ...(input.requestId != null ? { requestId: input.requestId } : {}),
      byLinkOnly: input.byLinkOnly === true,
      linkUnavailable: false,
      until: this.now() + (this.deps.forMs ?? WATCH_FOR_MS),
    });
    this.arm();
  }

  /**
   * Stop following what was offered with no session (a click in the app) for
   * this connector, or every such offer; an agent's own offers stand.
   */
  release(connectorId?: string): void {
    for (const [key, offer] of this.offers)
      if (
        offer.sessionId == null &&
        (connectorId == null || offer.connectorIds.includes(connectorId))
      )
        this.offers.delete(key);
  }

  stop(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.offers.clear();
  }

  private arm(): void {
    if (this.timer != null || this.offers.size === 0) return;
    this.timer = setTimeout(
      () => void this.check(),
      this.deps.everyMs ?? WATCH_EVERY_MS
    );
    this.timer.unref?.();
  }

  private async check(): Promise<void> {
    let statuses: ConnectorStatuses | null = null;
    try {
      statuses = await this.deps.list();
    } catch (error) {
      console.warn("[connectors] status read failed; trying again", error);
    }
    this.timer = null;
    for (const [key, offer] of this.offers) {
      const link = await this.linkState(offer);
      if (link.kind === "unavailable" && offer.byLinkOnly) {
        // Nothing is left to tell a reconnect landing; its card stays up.
        this.offers.delete(key);
        continue;
      }
      const landed =
        link.kind === "completed"
          ? link.landed
          : link.kind === "unavailable"
            ? this.fromStatuses(offer, statuses)
            : null;
      if (landed == null) {
        if (this.now() >= offer.until) {
          this.offers.delete(key);
          this.deps.expired(offer.connectorIds);
        }
        continue;
      }
      this.offers.delete(key);
      const accounts: Record<string, string> = {};
      for (const id of landed.connected) {
        const account = statuses?.[id]?.account;
        if (account != null && account.length > 0) accounts[id] = account;
      }
      this.deps.connected({
        sessionId: offer.sessionId,
        connectorIds: landed.connected,
        notGranted: landed.notGranted,
        accounts,
      });
    }
    this.arm();
  }

  /**
   * What the statuses say landed, or null for nothing yet. Some but not all
   * of an offer's connectors connected: the rest of that consent is given
   * settleMs to land before it counts as not granted.
   */
  private fromStatuses(
    offer: Offer,
    statuses: ConnectorStatuses | null
  ): Landed | null {
    const connected = offer.connectorIds.filter(
      (id) => statuses?.[id]?.state === "connected"
    );
    if (connected.length === 0) return null;
    const notGranted = offer.connectorIds.filter(
      (id) => !connected.includes(id)
    );
    if (notGranted.length > 0) {
      offer.partlySince ??= this.now();
      if (this.now() - offer.partlySince < (this.deps.settleMs ?? SETTLE_MS))
        return null;
    }
    return { connected, notGranted };
  }

  /**
   * What the offer's link says. The first time the server cannot say (an
   * older server, or a failed read), the offer stops asking and is judged by
   * the statuses from then on.
   */
  private async linkState(offer: Offer): Promise<LinkState> {
    if (
      offer.requestId == null ||
      this.deps.linkStatus == null ||
      offer.linkUnavailable
    )
      return { kind: "unavailable" };
    let outcome: LinkOutcome = null;
    try {
      outcome = await this.deps.linkStatus(offer.requestId);
    } catch (error) {
      console.warn("[connectors] link status read failed", error);
    }
    if (outcome == null) {
      offer.linkUnavailable = true;
      return { kind: "unavailable" };
    }
    if (!outcome.completed) return { kind: "pending" };
    return {
      kind: "completed",
      landed: {
        connected: offer.connectorIds.filter((id) =>
          outcome.connected.includes(id)
        ),
        notGranted: offer.connectorIds.filter((id) =>
          outcome.notGranted.includes(id)
        ),
      },
    };
  }
}
