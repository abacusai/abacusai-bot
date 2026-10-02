/**
 * The thread store (spec 02 §4.1): one TanStack Store per generation of a
 * thread, holding what the transcript's messages do not: permission
 * descriptors, the host queue, agent state, runs and their outcomes, live
 * tool output and display, activity and notices. Session-scoped slices
 * start from the hydrate snapshot; run-scoped ones are rebuilt from the
 * inclusive replay of the active run (§3.3).
 */
import { Store } from "@tanstack/react-store";

import type { ToolDisplayData } from "#shared/agent-types";
import type {
  AgentStatus,
  QueueEntry,
  SkillMetadata,
} from "#shared/agent-types";
import type { AiThreadSnapshot } from "#shared/contract/ai-thread";
import type {
  AgentState,
  PermissionDescriptor,
  RunOutcomeRecord,
} from "#shared/contract/ai-thread";

export type {
  AgentState,
  PermissionDescriptor,
  QueueEntry,
  RunOutcomeRecord,
  SkillMetadata,
  ToolDisplayData,
};

export type ThreadSkin = "bot" | "session";

/** `(subagentRunId ?? "", toolCallId)`, agent spec §3.5.4. */
export type ToolKey = `${string}\u0000${string}`;

export const toolKey = (
  subagentRunId: string | null | undefined,
  toolCallId: string
): ToolKey => `${subagentRunId ?? ""}\u0000${toolCallId}`;

interface ActiveRun {
  runId: string;
  /** Epoch ms. */
  startedAt: number;
  serverInitiated: boolean;
}

interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  isNetworkError: boolean;
}

export interface Notice {
  /** `notificationKey`, or `seq:<n>` when the agent sent none. */
  key: string;
  seq: number;
  name: "agent.notification" | "agent.error" | "abacus.notice";
  value: Record<string, unknown>;
}

export type AnsweringState =
  | { state: "sending"; decision: string; since: number }
  | { state: "error"; message: ResponseProblem; since: number };

/** Why an answer did not land (§6.3), as an i18n key suffix. */
type ResponseProblem =
  | "notPending"
  | "incarnation"
  | "earlierTurn"
  | "invalid"
  | "noResponse";

export interface QueueCommandState {
  state: "pending" | "rejected" | "timeout";
  command: "update" | "remove";
  reason?: "incarnation" | "not_found";
  /** The text the row had when the command went out (for "effect visible"). */
  text?: string;
  since: number;
}

export interface ThreadStoreState {
  /** Session slices skip `seq ≤ sessionCursor` (§3.3). */
  sessionCursor: number;
  subagentTimes: Record<string, { start: number; end?: number }>;
  incarnation: string | null;
  agent: AgentState | null;
  permissions: {
    items: PermissionDescriptor[];
    answering: Record<string, AnsweringState>;
  };
  queue: QueueEntry[];
  queueCommands: Record<string, QueueCommandState>;
  runs: { active: ActiveRun | null; outcomes: RunOutcomeRecord[] };
  tools: {
    output: Record<ToolKey, string>;
    display: Record<ToolKey, ToolDisplayData>;
  };
  activity: {
    status: AgentStatus | null;
    runningTools: number;
    retry: RetryInfo | null;
  };
  notices: Notice[];
  skills: SkillMetadata[];
  /** Messages whose first chunk arrived live (not hydrated, not replayed). */
  fresh: Record<string, true>;
}

export const emptyThreadState = (cursor = 0): ThreadStoreState => ({
  sessionCursor: cursor,
  subagentTimes: {},
  incarnation: null,
  agent: null,
  permissions: { items: [], answering: {} },
  queue: [],
  queueCommands: {},
  runs: { active: null, outcomes: [] },
  tools: { output: {}, display: {} },
  activity: { status: null, runningTools: 0, retry: null },
  notices: [],
  skills: [],
  fresh: {},
});

const noticeKey = (notice: {
  seq: number;
  value: Record<string, unknown>;
}): string =>
  typeof notice.value.notificationKey === "string"
    ? notice.value.notificationKey
    : `seq:${notice.seq}`;

/** The session-scoped slices from `ai.hydrate`'s snapshot (§3.3 step 4). */
export const stateFromSnapshot = (
  snapshot: AiThreadSnapshot
): ThreadStoreState => {
  const notices = new Map<string, Notice>();
  for (const notice of snapshot.notices)
    notices.set(noticeKey(notice), { ...notice, key: noticeKey(notice) });
  return {
    ...emptyThreadState(snapshot.cursor),
    incarnation: snapshot.incarnation,
    agent: snapshot.agent,
    permissions: {
      items: snapshot.permissions.filter(
        (item) =>
          snapshot.incarnation == null ||
          item.metadata.abacus.lineage.incarnation === snapshot.incarnation
      ),
      answering: {},
    },
    queue: snapshot.queue.filter((entry) => entry.hidden !== true),
    runs: {
      active:
        snapshot.activeRun == null
          ? null
          : {
              runId: snapshot.activeRun.runId,
              startedAt: snapshot.activeRun.startedAt,
              serverInitiated: snapshot.activeRun.serverInitiated,
            },
      outcomes: [...snapshot.runOutcomes],
    },
    activity: {
      status: snapshot.activity.status,
      runningTools: snapshot.activity.runningTools,
      retry: null,
    },
    notices: [...notices.values()],
    skills: snapshot.skills,
  };
};

export const createThreadStore = (
  initial: ThreadStoreState
): Store<ThreadStoreState> => new Store(initial);

export { noticeKey };
