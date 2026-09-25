/**
 * Proof the agent is alive while a tool runs. The desktop's watchdog ends a
 * turn that has gone quiet, and a running tool is silent by default (pi
 * reports bash output only when the command writes). The heartbeat runs only
 * while a call is outstanding and dies with the agent process, so a wedged
 * agent is still caught while a slow one is left to finish.
 */
import type { DesktopEvent } from "./protocol.js";

/**
 * Far below the desktop's watchdog (INACTIVITY_TIMEOUT_MS) so a scheduling
 * hiccup cannot read as a dead agent; turn-watchdog-budget.test.ts asserts it.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a single call may be vouched for. Several tools (`document`,
 * `ppt`, `design`, `delegate_task`, `browser_task`) cannot be killed, and
 * vouching for them forever would make a turn that can never end. Past this
 * the agent goes quiet and lets the watchdog act. Clear of the longest tool
 * budget (900s); asserted in turn-watchdog-budget.test.ts.
 */
export const MAX_VOUCHED_RUNTIME_MS = 20 * 60_000;

export class ToolHeartbeat {
  /** Outstanding tool calls, by the time each started. */
  private readonly running = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly emit: (event: DesktopEvent) => void,
    private readonly intervalMs: number = HEARTBEAT_INTERVAL_MS,
    private readonly maxRuntimeMs: number = MAX_VOUCHED_RUNTIME_MS
  ) {}

  /** How many calls are outstanding, whether or not they are still vouched for. */
  get size(): number {
    return this.running.size;
  }

  /** Calls young enough to still be credible: what the heartbeat reports. */
  private vouchedFor(): number {
    const now = Date.now();
    let count = 0;
    for (const startedAt of this.running.values()) {
      if (now - startedAt < this.maxRuntimeMs) count += 1;
    }

    return count;
  }

  started(toolCallId: string): void {
    this.running.set(toolCallId, Date.now());

    if (this.timer != null) return;

    this.timer = setInterval(() => {
      const live = this.vouchedFor();

      // Every call ended or outran its vouching; let the watchdog have its say.
      if (live === 0) {
        this.stop();

        return;
      }

      this.emit({ type: "heartbeat", runningTools: live });
    }, this.intervalMs);

    // A pending heartbeat must never be the reason the process stays up.
    this.timer.unref?.();
  }

  ended(toolCallId: string): void {
    this.running.delete(toolCallId);
    if (this.running.size === 0) this.stop();
  }

  /**
   * Drop every outstanding call. Runs wherever a turn can end, since a call
   * whose end event never arrives would otherwise beat for the process's life.
   */
  clear(): void {
    this.running.clear();
    this.stop();
  }

  private stop(): void {
    if (this.timer == null) return;

    clearInterval(this.timer);
    this.timer = null;
  }
}
