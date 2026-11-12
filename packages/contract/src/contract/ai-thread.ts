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
  /** The run answered on the free models chosen at the credit wall. */
  freeLane?: { provider: string | null };
  /** The Abacus credits the run's requests billed; absent when none went to Abacus or a charge is unknown. */
  credits?: number;
  /** Tokens the run's last request sent: how long the chat was by then. */
  contextTokens?: number;
  error?: AgentErrorPayload & { code?: string };
  /** The last transcript message at the terminal; null for an empty thread. */
  afterMessageId: string | null;
}

/**
 * Whether a finished run answered on the free lane, read off its terminal's
 * `metadata.abacus.turnUsage` (the agent's TurnUsage), for every place that
 * folds terminals into outcomes.
 */
export const freeLaneOf = (
  metadata: unknown
): RunOutcomeRecord["freeLane"] | undefined => {
  const usage = (
    metadata as
      | { abacus?: { turnUsage?: { lane?: unknown; provider?: unknown } } }
      | null
      | undefined
  )?.abacus?.turnUsage;
  if (usage?.lane !== "free") return undefined;
  return {
    provider: typeof usage.provider === "string" ? usage.provider : null,
  };
};

/**
 * The Abacus credits a finished run billed, read off its terminal's
 * `metadata.abacus.turnUsage.credits`; undefined when it has no known sum.
 */
export const creditsOf = (metadata: unknown): number | undefined => {
  const credits = (
    metadata as
      | { abacus?: { turnUsage?: { credits?: unknown } } }
      | null
      | undefined
  )?.abacus?.turnUsage?.credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0
    ? credits
    : undefined;
};

/** The run in flight at the checkpoint. */
export interface AiActiveRun {
  runId: string;
  /** The relay seq of its `RUN_STARTED`: replay is `[startSeq, …]`. */
  startSeq: number;
  /** Epoch ms. */
  startedAt: number;
  serverInitiated: boolean;
}

/**
 * A live `agent.notification`, a non-terminal `agent.error`, or main's own
 * `abacus.notice` about the thread (a history too large to read: `value`
 * `{ kind: "too-large", size, limit, path, notificationKey: "abacus.history" }`;
 * a thread file a newer build wrote: `{ kind: "foreign", notificationKey }`;
 * a save the full disk refused: `{ kind: "unsaved", notificationKey:
 * "abacus.unsaved" }`). A keyed notice with `cleared: true` takes its key's
 * notice back.
 */
export interface AiNotice {
  /** The relay seq it arrived at. */
  seq: number;
  name: "agent.notification" | "agent.error" | "abacus.notice";
  value: Record<string, unknown> & {
    /** Absolute file path for the history notice's Show in folder action. */
    path?: string;
  };
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

/**
 * How long the chat was at a finished run's last request: everything that
 * request sent (fresh input, cache reads, cache writes), read off its
 * terminal's `metadata.abacus.turnUsage`. Undefined when unknown or zero.
 */
export const contextTokensOf = (metadata: unknown): number | undefined => {
  const usage = (
    metadata as
      | {
          abacus?: {
            turnUsage?: {
              input?: unknown;
              cacheRead?: unknown;
              cacheWrite?: unknown;
            };
          };
        }
      | null
      | undefined
  )?.abacus?.turnUsage;
  if (usage == null) return undefined;
  const parts = [usage.input, usage.cacheRead, usage.cacheWrite].map((part) =>
    typeof part === "number" && Number.isFinite(part) && part > 0 ? part : 0
  );
  const total = parts.reduce((sum, part) => sum + part, 0);
  return total > 0 ? total : undefined;
};
