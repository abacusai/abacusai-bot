/**
 * Proof the agent is alive while a tool runs or the model writes. The
 * desktop's watchdog ends a turn that has gone quiet, and a running tool is
 * silent by default (pi reports bash output only when the command writes),
 * as is a model streaming a long tool call's arguments (those reach only the
 * AG-UI stream). The heartbeat runs only while a call is outstanding or the
 * model's output keeps arriving, and dies with the agent process, so a wedged
 * agent is still caught while a slow one is left to finish.
 */
import type { DesktopEvent } from "./protocol.js";
import { describeToolCall } from "./tool-display.js";

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
 * budget (an install's 1800s), so the install is killed and reported before
 * the watchdog gives up on the turn; asserted in turn-watchdog-budget.test.ts.
 */
export const MAX_VOUCHED_RUNTIME_MS = 35 * 60_000;

export class ToolHeartbeat {
  /** Outstanding tool calls: when each started, and what it is (describeToolCall). */
  private readonly running = new Map<
    string,
    { startedAt: number; label: string | null }
  >();
  /** When the model last streamed a piece of its reply. */
  private modelSpokeAt: number | null = null;
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
  private vouchedFor(): Array<string | null> {
    const now = Date.now();
    const labels: Array<string | null> = [];
    for (const call of this.running.values()) {
      if (now - call.startedAt < this.maxRuntimeMs) labels.push(call.label);
    }

    return labels;
  }

  /** The model spoke within the last beat: it is writing, not wedged. */
  private modelWriting(): boolean {
    return (
      this.modelSpokeAt != null &&
      Date.now() - this.modelSpokeAt < this.intervalMs
    );
  }

  started(
    toolCallId: string,
    tool?: { name?: unknown; input?: Record<string, unknown> }
  ): void {
    this.running.set(toolCallId, {
      startedAt: Date.now(),
      label: tool != null ? describeToolCall(tool) : null,
    });
    this.beat();
  }

  /**
   * The model streamed a piece of its reply (text, thinking, a tool call's
   * arguments). Only output vouches for it: a silent stream is StallWatch's.
   */
  generating(): void {
    this.modelSpokeAt = Date.now();
    this.beat();
  }

  ended(toolCallId: string): void {
    this.running.delete(toolCallId);
    if (this.running.size === 0 && !this.modelWriting()) this.stop();
  }

  private beat(): void {
    if (this.timer != null) return;

    this.timer = setInterval(() => {
      const live = this.vouchedFor();

      // Every call ended or outran its vouching and the model is quiet; let
      // the watchdog have its say.
      if (live.length === 0 && !this.modelWriting()) {
        this.stop();

        return;
      }

      // The newest call still running names the wait; none is the model.
      const tool = live.at(-1);
      this.emit({
        type: "heartbeat",
        runningTools: live.length,
        ...(tool != null ? { tool } : {}),
      });
    }, this.intervalMs);

    // A pending heartbeat must never be the reason the process stays up.
    this.timer.unref?.();
  }

  /**
   * Drop every outstanding call. Runs wherever a turn can end, since a call
   * whose end event never arrives would otherwise beat for the process's life.
   */
  clear(): void {
    this.running.clear();
    this.modelSpokeAt = null;
    this.stop();
  }

  private stop(): void {
    if (this.timer == null) return;

    clearInterval(this.timer);
    this.timer = null;
  }
}
