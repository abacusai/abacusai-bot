/**
 * The thread state `ai.hydrate` returns beside the transcript (spec 02
 * §14.1, §14.7), and the durable run outcome main persists per terminal.
 * Types only. The agent's wire types come from `@abacus-ai/agent`'s root,
 * which exports them type-only (agent spec §6.3).
 */
import type {
  AgentErrorPayload,
  AgentState,
  PermissionDescriptor,
} from "@abacus-ai/agent";

import type { AgentStatus, QueueEntry, SkillMetadata } from "../agent-types";

export type { AgentErrorPayload, AgentState, PermissionDescriptor };

/** `@ag-ui/core`'s `TokenUsage` as the agent fills it (agent spec §3.3.8). */
export interface RunTokenUsage {
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** One run's outcome, persisted independently of its messages (spec 02 §14.7). */
export interface RunOutcomeRecord {
  runId: string;
  kind: "success" | "cancelled" | "error";
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  /** The run's parent tool calls (children count inside their card). */
  steps: number;
  usage?: RunTokenUsage;
  error?: AgentErrorPayload & { code?: string };
  /** The last transcript message at the terminal; null for an empty thread. */
  afterMessageId: string | null;
}

/** The run in flight at the checkpoint. */
export interface AiActiveRun {
  runId: string;
  /** The relay seq of its `RUN_STARTED`: replay is `[startSeq, …]`. */
  startSeq: number;
  /** Epoch ms. */
  startedAt: number;
  serverInitiated: boolean;
}

/** A live `agent.notification`, or a non-terminal `agent.error`. */
export interface AiNotice {
  /** The relay seq it arrived at. */
  seq: number;
  name: "agent.notification" | "agent.error";
  value: Record<string, unknown>;
}

export interface AiThreadSnapshot {
  /** The relay seq `N` of the checkpoint; session slices skip `seq ≤ N`. */
  cursor: number;
  /** The relay's lifetime; an event id from another epoch means resync. */
  epoch: string;
  /** The live agent process, from `wire.hello` / `session.ready`. */
  incarnation: string | null;
  activeRun: AiActiveRun | null;
  /** Latest `permission.pending`, live incarnation only. */
  permissions: PermissionDescriptor[];
  /** Latest `queue.updated`, hidden entries left out. */
  queue: QueueEntry[];
  agent: AgentState | null;
  skills: SkillMetadata[];
  activity: { status: AgentStatus; runningTools: number };
  notices: AiNotice[];
  /** For the returned message window (`page` applies to both). */
  runOutcomes: RunOutcomeRecord[];
}
