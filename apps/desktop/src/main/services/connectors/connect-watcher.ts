/**
 * Follows connectors a link or card was offered for until they connect, so
 * nothing has to wait inside a tool call. One status read per tick covers
 * every offer; an offer is reported once, with whichever of its connectors
 * connected (one Google consent lands several together), and is given up when
 * its link expires.
 */
import type { ConnectorStatuses } from "@abacus-ai/contract/contracts";

export interface ConnectedOffer {
  /** The session that asked, told once it lands; null for none. */
  sessionId: string | null;
  connectorIds: string[];
  /** Who each connected as, when the platform says. */
  accounts: Record<string, string>;
}

interface ConnectWatcherDeps {
  list: () => Promise<ConnectorStatuses>;
  connected: (offer: ConnectedOffer) => void;
  /** The offer's link expired unconnected. */
  expired: (connectorIds: string[]) => void;
  everyMs?: number;
  /** How long a link stays good. */
  forMs?: number;
  now?: () => number;
}

const WATCH_EVERY_MS = 5_000;
const WATCH_FOR_MS = 30 * 60_000;

export class ConnectWatcher {
  private readonly offers = new Map<
    string,
    { connectorIds: string[]; sessionId: string | null; until: number }
  >();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ConnectWatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The same connectors offered to the same session again restart its clock. */
  watch(input: { connectorIds: string[]; sessionId: string | null }): void {
    if (input.connectorIds.length === 0) return;
    const key = `${[...input.connectorIds].sort().join(",")}|${input.sessionId ?? ""}`;
    this.offers.set(key, {
      ...input,
      until: this.now() + (this.deps.forMs ?? WATCH_FOR_MS),
    });
    this.arm();
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
      const connected =
        statuses == null
          ? []
          : offer.connectorIds.filter(
              (id) => statuses[id]?.state === "connected"
            );
      if (connected.length > 0) {
        this.offers.delete(key);
        const accounts: Record<string, string> = {};
        for (const id of connected) {
          const account = statuses?.[id]?.account;
          if (account != null && account.length > 0) accounts[id] = account;
        }
        this.deps.connected({
          sessionId: offer.sessionId,
          connectorIds: connected,
          accounts,
        });
      } else if (this.now() >= offer.until) {
        this.offers.delete(key);
        this.deps.expired(offer.connectorIds);
      }
    }
    this.arm();
  }
}
