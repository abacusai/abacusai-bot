/**
 * How long the phone lane waits on the agent. The idle limit restarts on
 * every sign of real work (a tool starting or finishing, streamed output, a
 * progress line); the hard cap counts from the start and never restarts.
 * Either one running out gives the work up.
 */

export const PHONE_TURN_LIMITS = {
  /** No sign of work for this long: the agent is stuck, not busy. */
  idleMs: 10 * 60_000,
  /**
   * The idle limit while a long tool runs that can be quiet for minutes (a
   * browser run, whose own limit is 12 minutes): that tool's limit and a
   * minute. The hard cap still counts.
   */
  longToolIdleMs: 13 * 60_000,
  /**
   * However busy, a turn never runs longer than this. Under the server's
   * last redelivery (three, 15 minutes apart), so a long turn is acked
   * before the server gives up on its message and apologizes for it.
   */
  hardCapMs: 40 * 60_000,
};

export class TurnClock {
  private idle: NodeJS.Timeout | null = null;
  private cap: NodeJS.Timeout | null = null;
  /** Long tools in flight, by call id: the idle limit is theirs while any runs. */
  private readonly longTools = new Set<string>();

  constructor(
    private readonly limits: typeof PHONE_TURN_LIMITS,
    private readonly onExpired: (reason: "idle" | "cap") => void
  ) {}

  get running(): boolean {
    return this.cap != null;
  }

  /** Starts both limits; a no-op while already running. */
  start(): void {
    if (this.running) return;
    this.cap = setTimeout(() => this.expire("cap"), this.limits.hardCapMs);
    this.cap.unref?.();
    this.touch();
  }

  /** Real work happened: the idle limit starts over. */
  touch(): void {
    if (!this.running) return;
    if (this.idle != null) clearTimeout(this.idle);
    const idleMs =
      this.longTools.size > 0
        ? Math.max(this.limits.idleMs, this.limits.longToolIdleMs)
        : this.limits.idleMs;
    this.idle = setTimeout(() => this.expire("idle"), idleMs);
    this.idle.unref?.();
  }

  /** A long tool started (`running`) or finished: the idle limit follows it. */
  longTool(callId: string, running: boolean): void {
    if (running) this.longTools.add(callId);
    else this.longTools.delete(callId);
    this.touch();
  }

  stop(): void {
    if (this.idle != null) clearTimeout(this.idle);
    if (this.cap != null) clearTimeout(this.cap);
    this.idle = null;
    this.cap = null;
    this.longTools.clear();
  }

  private expire(reason: "idle" | "cap"): void {
    this.stop();
    this.onExpired(reason);
  }
}
