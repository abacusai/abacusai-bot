/**
 * How long the phone lane waits on the agent. The idle limit restarts on
 * every sign of real work (a tool starting or finishing, streamed output, a
 * progress line); the hard cap counts from the start and never restarts.
 * Either one running out gives the work up.
 */

export const PHONE_TURN_LIMITS = {
  /** No sign of work for this long: the agent is stuck, not busy. */
  idleMs: 10 * 60_000,
  /** However busy, a turn never runs longer than this. */
  hardCapMs: 45 * 60_000,
};

export class TurnClock {
  private idle: NodeJS.Timeout | null = null;
  private cap: NodeJS.Timeout | null = null;

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
    this.idle = setTimeout(() => this.expire("idle"), this.limits.idleMs);
    this.idle.unref?.();
  }

  stop(): void {
    if (this.idle != null) clearTimeout(this.idle);
    if (this.cap != null) clearTimeout(this.cap);
    this.idle = null;
    this.cap = null;
  }

  private expire(reason: "idle" | "cap"): void {
    this.stop();
    this.onExpired(reason);
  }
}
