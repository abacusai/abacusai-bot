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
 * A session's sends go through here in order: each waits for the ones before
 * it (their reconcile and delivery), so a message steered in behind a turn
 * start never overtakes it, and no refresh lands under a turn it started.
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
  /** Whether the session's agent is in a turn now (streaming, or asking). */
  turnRunning: (session: SessionRef) => boolean;
  /**
   * Rewrites the session's MCP runtime file and asks its agent to reconnect
   * under `requestId`; false when no agent is running to ask. The agent
   * answers through `refreshed` with the same id when it is done.
   */
  refresh: (session: SessionRef, requestId: string) => Promise<boolean>;
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
  /** A started session's set, being read because nothing was cached. */
  private readonly seeding = new Map<string, Promise<void>>();
  /** Each session's last send in line: the next one starts after it. */
  private readonly lines = new Map<string, Promise<void>>();
  /** Sessions a send was delivered to whose turn has not ended yet. */
  private readonly open = new Set<string>();
  /** A session's refresh in flight; a second ask joins it. */
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Refreshes waiting on their agent's answer, by request id. */
  private readonly waiting = new Map<string, (ok: boolean) => void>();
  private requests = 0;
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
   * Delivers a message to a session after every send before it, with the
   * session's tools brought to the platform's connected set first unless the
   * message joins a running turn: a turn is never refreshed under. Whether
   * it joins one is judged when it reaches the head of the line (a send
   * before it was delivered and its turn has not ended, or the agent is in
   * a turn), not at its arrival. Must be called synchronously at the send's
   * arrival, so the line is the arrival order. `deliver` resolves to whether
   * the message reached the agent. A listing that cannot be read leaves the
   * tools.
   */
  inTurnOrder<T>(
    session: SessionRef,
    deliver: () => Promise<T>,
    reached: (result: T) => boolean = () => true
  ): Promise<T> {
    const before = this.lines.get(session.sessionId) ?? Promise.resolve();
    const run = before.then(async () => {
      const midTurn =
        this.open.has(session.sessionId) || this.deps.turnRunning(session);
      if (!midTurn) await this.reconcile(session);
      const result = await deliver();
      if (reached(result)) this.open.add(session.sessionId);
      return result;
    });
    const line = run.then(
      () => undefined,
      () => undefined
    );
    this.lines.set(session.sessionId, line);
    void line.then(() => {
      if (this.lines.get(session.sessionId) === line)
        this.lines.delete(session.sessionId);
    });
    return run;
  }

  /** In line like any send, for a path that delivers on its own right after. */
  beforeTurn(session: SessionRef): Promise<void> {
    return this.inTurnOrder(session, async () => undefined);
  }

  /** The session's turn ended (it went idle): the next send starts a turn. */
  turnEnded(sessionId: string): void {
    this.open.delete(sessionId);
  }

  /**
   * A session's agent reported its MCP servers. Only a start counts here: the
   * set it was built with is recorded, read now when nothing is cached, so
   * its first turn does not reconnect for nothing. A refresh's end is
   * `refreshed`, never this: these reports also go out mid-refresh.
   */
  serversReported(sessionId: string): void {
    if (this.built.has(sessionId) || this.seeding.has(sessionId)) return;
    if (this.cached != null && this.cached.snapshot.reason == null) {
      this.built.set(sessionId, signatureOf(this.cached.snapshot));
      return;
    }
    const seed = this.platform()
      .then((snapshot) => {
        if (snapshot.reason == null && !this.built.has(sessionId))
          this.built.set(sessionId, signatureOf(snapshot));
      })
      .catch(() => undefined)
      .finally(() => this.seeding.delete(sessionId));
    this.seeding.set(sessionId, seed);
  }

  /** The agent's answer to a refresh asked for under `requestId`. */
  refreshed(requestId: string, ok: boolean): void {
    this.waiting.get(requestId)?.(ok);
  }

  /** The session's agent is gone: whatever it was built with went with it. */
  forget(sessionId: string): void {
    this.built.delete(sessionId);
    this.seeding.delete(sessionId);
    this.open.delete(sessionId);
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

  private async reconcile(session: SessionRef): Promise<void> {
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
    await this.seeding.get(session.sessionId);
    const signature = signatureOf(snapshot);
    if (this.built.get(session.sessionId) === signature) return;
    await this.refreshSession(session, signature);
  }

  private refreshSession(
    session: SessionRef,
    signature: string
  ): Promise<void> {
    const inFlight = this.refreshing.get(session.sessionId);
    if (inFlight != null) return inFlight;
    const refresh = this.runRefresh(session, signature).finally(() =>
      this.refreshing.delete(session.sessionId)
    );
    this.refreshing.set(session.sessionId, refresh);
    return refresh;
  }

  private async runRefresh(
    session: SessionRef,
    signature: string
  ): Promise<void> {
    this.requests += 1;
    const requestId = `connectors-${this.requests}`;
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        this.deps.refreshWaitMs ?? REFRESH_WAIT_MS
      );
      timer.unref?.();
      this.waiting.set(requestId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
    let asked = false;
    try {
      asked = await this.deps.refresh(session, requestId);
    } catch (error) {
      this.deps.log?.(
        `[mcp] connector refresh for ${session.sessionId} failed: ${String(error)}`
      );
    }
    const ok = asked && (await answered);
    this.waiting.delete(requestId);
    if (ok) {
      // Only a confirmed refresh moves what the session was built with.
      this.built.set(session.sessionId, signature);
      this.deps.log?.(
        `[mcp] connectors refreshed for ${session.sessionId}: ${signature || "none"}`
      );
    } else if (asked) {
      // Still stale, so the next turn start tries again; the agent applies a
      // late refresh at its own next turn start, never under a running one.
      this.deps.log?.(
        `[mcp] connector refresh for ${session.sessionId} did not finish; retried next turn`
      );
    }
  }
}
