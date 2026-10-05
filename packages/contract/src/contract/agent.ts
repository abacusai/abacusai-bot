import { type } from "@orpc/contract";
import * as v from "valibot";

import type {
  AgentSessionSnapshot,
  StartAgentSessionResult,
  StopAgentSessionResult,
  TurnFeedbackOutcome,
} from "../contracts";
import { mutation, query } from "./base";
import { AgentModeSchema, SessionId, WorkspaceId } from "./ids";

export const TurnFeedbackInputSchema = v.object({
  sessionId: SessionId,
  segmentId: v.pipe(v.string(), v.nonEmpty()),
  rating: v.picklist(["up", "down", "clear"]),
  comment: v.optional(v.string()),
  model: v.optional(v.nullable(v.string())),
});

export const StartAgentSessionRequestSchema = v.object({
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  startupTimeoutMs: v.optional(v.number()),
  model: v.optional(v.nullable(v.string())),
  mode: v.optional(v.nullable(AgentModeSchema)),
});

const commandEntries = { workspaceId: WorkspaceId, sessionId: SessionId };

export const AgentSessionCommandRequestSchema = v.object(commandEntries);

export const AgentSetModeRequestSchema = v.object({
  ...commandEntries,
  mode: AgentModeSchema,
});

export const AgentSetModelRequestSchema = v.object({
  ...commandEntries,
  model: v.pipe(v.string(), v.nonEmpty()),
});

export const AgentPermissionResponseRequestSchema = v.object({
  ...commandEntries,
  permissionId: v.pipe(v.string(), v.nonEmpty()),
  decision: v.unknown(),
});

export const AgentSwitchConversationRequestSchema = v.object({
  ...commandEntries,
  conversationId: v.pipe(v.string(), v.nonEmpty()),
});

export const AgentQueueMessageRequestSchema = v.object({
  ...commandEntries,
  message: v.string(),
  hidden: v.optional(v.boolean()),
});

export const AgentRemoveFromQueueRequestSchema = v.object({
  ...commandEntries,
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const AgentUpdateQueueMessageRequestSchema = v.object({
  ...commandEntries,
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  message: v.string(),
});

/**
 * The agent process behind a session: start/stop, mode and model, and the
 * message queue. The conversation itself (send, cancel, stream) is `ai.*`.
 */
export const agent = {
  feedback: mutation
    .input(TurnFeedbackInputSchema)
    .output(type<TurnFeedbackOutcome>()),
  /**
   * Spawns the child; its stream arrives on `ai.subscribe`. Without a
   * `model`/`mode` it runs on the session row's (spec 04 §26.4 d).
   */
  start: mutation
    .input(StartAgentSessionRequestSchema)
    .output(type<StartAgentSessionResult>()),
  stop: mutation
    .input(AgentSessionCommandRequestSchema)
    .output(type<StopAgentSessionResult>()),
  state: query
    .input(AgentSessionCommandRequestSchema)
    .output(type<AgentSessionSnapshot>()),
  setMode: mutation.input(AgentSetModeRequestSchema).output(type<void>()),
  /**
   * Switches the running agent's model and resolves when it has; the
   * agent's refusal is `CONFLICT {reason: "model-unavailable"}` with its
   * message (spec 04 §26.4 d). No answer within a few seconds resolves.
   */
  setModel: mutation.input(AgentSetModelRequestSchema).output(type<void>()),
  reset: mutation.input(AgentSessionCommandRequestSchema).output(type<void>()),
  switchConversation: mutation
    .input(AgentSwitchConversationRequestSchema)
    .output(type<void>()),
  /** A thin alias until the chat kit resumes interrupts through `ai.send`. */
  respondPermission: mutation
    .input(AgentPermissionResponseRequestSchema)
    .output(type<void>()),
  /** Asks the child to report its skills; they arrive on the session stream. */
  skills: query.input(AgentSessionCommandRequestSchema).output(type<void>()),
  queue: {
    enqueue: mutation
      .input(AgentQueueMessageRequestSchema)
      .output(type<void>()),
    dequeue: mutation
      .input(AgentSessionCommandRequestSchema)
      .output(type<void>()),
    /** Asks the child to report its queue; it arrives on the session stream. */
    get: query.input(AgentSessionCommandRequestSchema).output(type<void>()),
    clear: mutation
      .input(AgentSessionCommandRequestSchema)
      .output(type<void>()),
    remove: mutation
      .input(AgentRemoveFromQueueRequestSchema)
      .output(type<void>()),
    update: mutation
      .input(AgentUpdateQueueMessageRequestSchema)
      .output(type<void>()),
  },
};
