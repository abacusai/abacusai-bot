/**
 * Internal events (spec 00-agent-agui §6.3).
 *
 * Deliberately not in `protocol.ts`: that file is the NDJSON wire mirrored
 * by the desktop app's `agent-types.ts`, and these never travel on it.
 */

/**
 * Facts the NDJSON wire never carried, for the AG-UI emitter only. They go
 * through `emitInternal`, never through `emit`, so no legacy line is ever
 * written for them: `messaging-gateway-service` resets its reply buffer on a
 * `tool_call_start`, which is why these must never reach the compat stream.
 */
export type InternalAgentEvent =
  /**
   * An assistant message began; `key` is the legacy `msg-N`, `messageId` the
   * AG-UI id when pi gave the message a timestamp. Without one the emitter
   * builds an incarnation-scoped id, since `msg-N` restarts per process.
   */
  | { type: "message_open"; key: string; messageId?: string }
  /** The assistant message `key` ended, with pi's stop reason. */
  | { type: "message_close"; key: string; stopReason?: string }
  /** A tool call is known: streamed from the provider, or at gate entry. */
  | {
      type: "tool_call_start";
      toolCallId: string;
      toolName: string;
      rawName: string;
      input?: Record<string, unknown>;
    }
  | { type: "tool_call_delta"; toolCallId: string; argumentsDelta: string }
  | {
      type: "tool_call_stop";
      toolCallId: string;
      toolName: string;
      arguments: string;
    }
  /** The gate blocked a call; decides the result's `toolResultOutcome`. */
  | {
      type: "tool_blocked";
      toolCallId: string;
      cause: "rejected" | "refused" | "expired" | "stopped";
    }
  /** The plan after a successful `todo` set, as stored. */
  | {
      type: "plan_changed";
      todos: Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>;
    }
  /** A bot housekeeping turn: nothing inside it reaches AG-UI but permissions. */
  | { type: "hidden_turn"; phase: "start" | "end"; customType: string };
