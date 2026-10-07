/**
 * The one owner of "the user's connector set changed". The platform's
 * connector listing is read here (with a short TTL, one read shared by every
 * caller at a time), and each live session's tools are kept on the set its
 * MCP was last built with. A session whose set differs from the platform's is
 * refreshed at the start of its next turn, before the message is delivered,
 * never in the middle of one, so the tools the model sees match what the
 * account has: added from this app, a browser, another device, or removed by
 * a disconnect, a revoke or an admin.
 *
 * Every reader of connector state (the statuses, connect_connector, the
 * environment notice, the connected note) reads this snapshot, so none of
 * them can disagree with the tools.
 */

export interface PlatformSnapshot {
  available: ReadonlySet<string>;
  connected: ReadonlySet<string>;
  accounts: Readonly<Record<string, string>>;
  /** Why there is no listing (signed out, unreachable); nothing else is set. */
  reason?: string;
}

export interface SessionRef {
  workspaceId: string;
  sessionId: string;
}

interface ConnectorSyncDeps {
  /** The platform's listing, as it stands now. */
  read: () => Promise<PlatformSnapshot>;
  /** Sessions with a running agent. */
  liveSessions: () => SessionRef[];
  /**
   * Rewrites the session's MCP runtime file and asks its agent to reconnect;
   * false when no agent is running to ask. The agent reports its servers
   * (`serversReported`) or a failure (`refreshFailed`) when done.
   */
  refresh: (session: SessionRef) => Promise<boolean>;
  /** The listing moved: the renderer re-reads, once per change. */
  changed: () => void;
  log?: (line: string) => void;
  ttlMs?: number;
  refreshWaitMs?: number;
  now?: () => number;
}

const SYNC_TTL_MS = 20_000;
const REFRESH_WAIT_MS = 5_000;

/** What a session's connector tools depend on: the connected services. */
const signatureOf = (snapshot: PlatformSnapshot): string =>
  [...snapshot.connected].sort().join(",");

/** The whole listing, for telling a change from a repeat. */
const fingerprintOf = (snapshot: PlatformSnapshot): string =>
  JSON.stringify([
    snapshot.reason ?? null,
    [...snapshot.available].sort(),
    signatureOf(snapshot),
    Object.entries(snapshot.accounts).sort(([a], [b]) => a.localeCompare(b)),
  ]);

export class ConnectorSync {
  private cached: { snapshot: PlatformSnapshot; at: number } | null = null;
  private reading: Promise<PlatformSnapshot> | null = null;
  /** The connected set each live session's tools were built with. */
  private readonly built = new Map<string, string>();
  /** Refreshes waiting on their session's report, by session id. */
  private readonly waiting = new Map<string, (ok: boolean) => void>();
  /** A change here was announced already; the read that sees it stays quiet. */
  private announced = false;
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorSyncDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * The platform's listing: the cached one while it is younger than the TTL,
   * else one fresh read shared by every caller waiting on it. `fresh` skips
   * the cache, for a caller that has to see a change within seconds.
   */
  async platform(options: { fresh?: boolean } = {}): Promise<PlatformSnapshot> {
    const cached = this.cached;
    if (
      options.fresh !== true &&
      cached != null &&
      this.now() - cached.at < (this.deps.ttlMs ?? SYNC_TTL_MS)
    )
      return cached.snapshot;
    this.reading ??= this.readNow().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /**
   * Something here moved a connector (a connect, a disconnect): the next read
   * is fresh, and the change is announced now, once.
   */
  changed(): void {
    if (this.cached != null)
      this.cached = { ...this.cached, at: Number.NEGATIVE_INFINITY };
    this.announced = true;
    this.deps.changed();
  }

  /**
   * At a turn's start, before its message is delivered: the session's tools
   * are brought to the platform's connected set. A turn already running (a
   * message steered into it) is never refreshed under it; its session is
   * reconciled at its next turn start. A listing that cannot be read leaves
   * the tools as they are.
   */
  async beforeTurn(session: SessionRef, midTurn: boolean): Promise<void> {
    if (midTurn) return;
    let snapshot: PlatformSnapshot;
    try {
      snapshot = await this.platform();
    } catch {
      return;
    }
    if (snapshot.reason != null) return;
    const live = this.deps
      .liveSessions()
      .some((item) => item.sessionId === session.sessionId);
    // Not running: its agent builds its tools from the platform when it starts.
    if (!live) return;
    const signature = signatureOf(snapshot);
    if (this.built.get(session.sessionId) === signature) return;
    await this.refreshSession(session, signature);
  }

  /** A session's agent reported its MCP servers: a refresh finished, or it started. */
  serversReported(sessionId: string): void {
    const waiter = this.waiting.get(sessionId);
    if (waiter != null) {
      waiter(true);
      return;
    }
    // A start, built from the listing as it stood; unknown without one, which
    // the next turn start settles with a refresh.
    if (!this.built.has(sessionId) && this.cached != null)
      this.built.set(sessionId, signatureOf(this.cached.snapshot));
  }

  refreshFailed(sessionId: string): void {
    this.waiting.get(sessionId)?.(false);
  }

  /** The session's agent is gone: whatever it was built with went with it. */
  forget(sessionId: string): void {
    this.built.delete(sessionId);
    this.waiting.get(sessionId)?.(false);
  }

  private async readNow(): Promise<PlatformSnapshot> {
    const snapshot = await this.deps.read();
    const previous = this.cached?.snapshot;
    this.cached = { snapshot, at: this.now() };
    const moved =
      previous != null && fingerprintOf(previous) !== fingerprintOf(snapshot);
    if (moved && !this.announced) this.deps.changed();
    this.announced = false;
    return snapshot;
  }

  private async refreshSession(
    session: SessionRef,
    signature: string
  ): Promise<void> {
    if (this.waiting.has(session.sessionId)) return;
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        this.deps.refreshWaitMs ?? REFRESH_WAIT_MS
      );
      timer.unref?.();
      this.waiting.set(session.sessionId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
    let asked = false;
    try {
      asked = await this.deps.refresh(session);
    } catch (error) {
      this.deps.log?.(
        `[mcp] connector refresh for ${session.sessionId} failed: ${String(error)}`
      );
    }
    if (!asked) this.waiting.get(session.sessionId)?.(false);
    const ok = await done;
    this.waiting.delete(session.sessionId);
    if (ok) {
      this.built.set(session.sessionId, signature);
      this.deps.log?.(
        `[mcp] connectors refreshed for ${session.sessionId}: ${signature || "none"}`
      );
    } else if (asked) {
      // Still stale, so the next turn start tries again.
      this.deps.log?.(
        `[mcp] connector refresh for ${session.sessionId} did not finish; retried next turn`
      );
    }
  }
}
