/**
 * What one `send` answers, reported once as `turn_reply`: the ids of the
 * messages it answers, its final assistant message, and whether it failed
 * (with the failure's cause, so a chat app can say the right thing).
 * The final message is the last one the main session wrote words in; a
 * sub-agent's words never reach it. Only a send or steer with an id asks.
 */
import type { AgentEvent } from "../protocol.js";

export class TurnReply {
  private ids: string[] = [];
  private final = "";
  private draft = "";
  private failed = false;
  private cause: string | undefined;
  private open = false;

  /** A send starts; `messageId` is the sender's id for it. */
  begin(messageId?: string): void {
    this.ids = [];
    this.final = "";
    this.draft = "";
    this.failed = false;
    this.cause = undefined;
    this.open = true;
    this.answers(messageId);
  }

  /** A message steered into this turn: its answer is this turn's. */
  answers(messageId?: string): void {
    if (this.open && messageId != null) this.ids.push(messageId);
  }

  messageStarted(): void {
    this.draft = "";
  }

  textStreamed(text: string): void {
    this.draft += text;
  }

  messageEnded(): void {
    if (this.draft.trim().length > 0) this.final = this.draft;
    this.draft = "";
  }

  /** A stopped turn answers nothing: no `turn_reply`. */
  abandon(): void {
    this.open = false;
  }

  /** The turn reported an error; `cause` is its FailureCause (turn-outcome.ts), when it named one. */
  fail(cause?: string): void {
    if (!this.open) return;
    this.failed = true;
    this.cause = cause ?? this.cause;
  }

  /**
   * The turn's `turn_reply`, once; null when already taken, or when no
   * sender gave an id, so a sender that never asks hears nothing new.
   */
  take(): Extract<AgentEvent, { type: "turn_reply" }> | null {
    if (!this.open) return null;
    this.open = false;
    if (this.ids.length === 0) return null;
    return {
      type: "turn_reply",
      messageIds: this.ids,
      text: this.final,
      failed: this.failed,
      ...(this.failed && this.cause != null ? { cause: this.cause } : {}),
    };
  }
}
