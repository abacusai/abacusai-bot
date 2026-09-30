/**
 * A model call that has gone silent, noticed by both loops the same way.
 * Nothing in the stack ends a stalled stream before the desktop's
 * ten-minute watchdog: a response the server had finished and billed once
 * sat undelivered for fourteen minutes, then was reported as a hang. The
 * watch is armed while a model call is expected to be producing output and
 * never while a tool runs (tools have their own limits); when it fires the
 * loop aborts the call and carries the turn on, on the next pool model or
 * with the same model asked once more.
 */

const MODEL_STALL_MS = 120_000;

export const modelStallMs = (): number =>
  Number(process.env.ABACUSAI_BOT_MODEL_STALL_MS) || MODEL_STALL_MS;

/** A pinned model is asked once more; on the router the pool moves on instead. */
export const MAX_STALL_RECOVERIES_PER_TURN = 1;

export const STALL_CONTINUATION_TYPE = "abacusai-bot:stall-recovery";
export const STALL_CONTINUATION_PROMPT =
  "The previous provider call produced no output and was abandoned. Continue the task from the transcript above. Do not restart it or repeat work that already completed.";

export class StallWatch {
  private timer: NodeJS.Timeout | null = null;
  private awaitingModel = false;

  constructor(
    private readonly options: {
      turnRunning: () => boolean;
      /** Tool calls still running; the model is asked again only after the last. */
      toolsRunning: () => number;
      onStall: () => void;
      stallMs?: () => number;
    }
  ) {}

  /** Every pi event passes through here: which ones mean a call is being waited on. */
  note(eventType: string): void {
    switch (eventType) {
      case "tool_execution_end":
        // Parallel tool calls: the model is asked again only once the last
        // one ends. Arming here while a sibling still runs (a browser
        // sub-agent, minutes long) reads its silence as the model's and
        // aborts it. The heartbeat still holds the call that is ending.
        if (this.options.toolsRunning() > 1) return;
        this.awaitingModel = true;
        this.arm();
        return;
      case "agent_start":
      case "message_start":
        this.awaitingModel = true;
        this.arm();
        return;
      case "message_end":
      case "tool_execution_start":
      case "agent_end":
        this.awaitingModel = false;
        this.clear();
        return;
      default:
        // A delta of any kind is proof of life.
        if (this.awaitingModel) this.arm();
    }
  }

  /** The stall is the handler's now; false when the model had spoken since. */
  take(): boolean {
    if (!this.awaitingModel) return false;
    this.awaitingModel = false;
    return true;
  }

  clear(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.clear();
    if (!this.options.turnRunning()) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.options.onStall();
      },
      (this.options.stallMs ?? modelStallMs)()
    );
  }
}
