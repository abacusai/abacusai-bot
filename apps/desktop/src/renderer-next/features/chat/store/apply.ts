/**
 * The thread store's reducer (spec 02 §4.2), pure. `applyEvent` runs in the
 * dispatcher just before a chunk is yielded to the client ("pre-apply");
 * `recordTerminal` runs after the client processed a terminal ("post-apply",
 * §3.4), so it can read that run's final messages.
 *
 * Session-scoped rows (agent spec §2.3 *S*, and `STATE_*`) are skipped at
 * `seq ≤ sessionCursor`: the snapshot already holds them. Run-scoped rows
 * are always applied (replay is inclusive from the run's `RUN_STARTED`).
 */
import type { StreamChunk, UIMessage } from "@tanstack/ai";

import { applyPatch, type PatchOp } from "./json-patch";
import {
  noticeKey,
  toolKey,
  type AgentState,
  type Notice,
  type PermissionDescriptor,
  type QueueEntry,
  type RunOutcomeRecord,
  type ThreadStoreState,
  type ToolKey,
} from "./thread-store";

/** Custom names that live outside a run (agent `SESSION_SCOPED_CUSTOM`) plus main's. */
const SESSION_CUSTOM: ReadonlySet<string> = new Set([
  "session.ready",
  "session.cleared",
  "wire.hello",
  "wire.compat_lost",
  "agent.status",
  "agent.heartbeat",
  "agent.error",
  "agent.notification",
  "run.ack",
  "permission.requested",
  "permission.resolved",
  "permission.cleared",
  "permission.response_rejected",
  "permission.pending",
  "queue.updated",
  "queue.command_rejected",
  "skills.loaded",
  "mcp.servers",
  "mcp.server_logs",
]);

type Loose = Record<string, unknown>;

const valueOf = (event: StreamChunk): Loose => {
  const value = (event as { value?: unknown }).value;
  return value != null && typeof value === "object" ? (value as Loose) : {};
};

export const customName = (event: StreamChunk): string | null =>
  event.type === "CUSTOM" ? ((event as { name?: string }).name ?? null) : null;

/** Whether the store treats this event as session-scoped (§4.2). */
export const isSessionScoped = (event: StreamChunk): boolean => {
  if (event.type === "STATE_SNAPSHOT" || event.type === "STATE_DELTA")
    return true;
  const name = customName(event);
  return name != null && SESSION_CUSTOM.has(name);
};

export const isTerminal = (event: StreamChunk): boolean =>
  event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";

/** The run a terminal closes (`RUN_ERROR` carries it in `metadata.tanstack`). */
export const terminalRunId = (event: StreamChunk): string | null => {
  if (event.type === "RUN_FINISHED")
    return (event as { runId?: string }).runId ?? null;
  if (event.type === "RUN_ERROR") {
    const meta = (event as { metadata?: { tanstack?: { runId?: string } } })
      .metadata;
    return meta?.tanstack?.runId ?? (event as { runId?: string }).runId ?? null;
  }
  return null;
};

const eventTime = (event: StreamChunk, fallback: number): number => {
  const timestamp = (event as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && timestamp > 0 ? timestamp : fallback;
};

const subagentOf = (event: StreamChunk): string | undefined => {
  const id = (event as { subagentRunId?: unknown }).subagentRunId;
  return typeof id === "string" ? id : undefined;
};

const clearsRetry = (event: StreamChunk): boolean =>
  event.type.startsWith("TEXT_MESSAGE") ||
  event.type.startsWith("TOOL_CALL") ||
  event.type.startsWith("REASONING");

const applyPermissionEvent = (
  state: ThreadStoreState,
  name: string,
  value: Loose
): ThreadStoreState => {
  switch (name) {
    case "permission.pending": {
      const incarnation =
        typeof value.incarnation === "string" ? value.incarnation : null;
      const items = (
        Array.isArray(value.items) ? value.items : []
      ) as PermissionDescriptor[];
      const live = items.filter(
        (item) =>
          incarnation == null ||
          item.metadata.abacus.lineage.incarnation === incarnation
      );
      const ids = new Set(live.map((item) => item.id));
      const answering = Object.fromEntries(
        Object.entries(state.permissions.answering).filter(([id]) =>
          ids.has(id)
        )
      );
      return { ...state, permissions: { items: live, answering } };
    }
    case "permission.resolved":
    case "permission.cleared": {
      const id = String(value.permissionId ?? "");
      const { [id]: _gone, ...answering } = state.permissions.answering;
      return { ...state, permissions: { ...state.permissions, answering } };
    }
    case "permission.response_rejected": {
      const lineage = value.lineage as { permissionId?: string } | undefined;
      const id = lineage?.permissionId;
      if (id == null) return state;
      const reason = String(value.reason ?? "");
      const message =
        reason === "not_pending"
          ? "notPending"
          : reason === "incarnation"
            ? "incarnation"
            : reason === "thread" || reason === "turn"
              ? "earlierTurn"
              : "invalid";
      return {
        ...state,
        permissions: {
          ...state.permissions,
          answering: {
            ...state.permissions.answering,
            [id]: { state: "error", message, since: Date.now() },
          },
        },
      };
    }
    default:
      return state;
  }
};

const applyQueueUpdated = (
  state: ThreadStoreState,
  value: Loose
): ThreadStoreState => {
  const messages = (
    Array.isArray(value.messages) ? value.messages : []
  ) as QueueEntry[];
  const queue = messages.filter((entry) => entry.hidden !== true);
  const byId = new Map(queue.map((entry) => [entry.id, entry]));
  const queueCommands = Object.fromEntries(
    Object.entries(state.queueCommands).filter(([id, command]) => {
      if (command.state !== "pending") return true;
      const entry = byId.get(id);
      // Kept until the effect is visible: the entry gone after a remove, or
      // its text changed after an update (or gone: nothing left to show).
      if (command.command === "remove") return entry != null;
      return entry != null && entry.message !== command.text;
    })
  );
  return { ...state, queue, queueCommands };
};

const applyNotice = (
  state: ThreadStoreState,
  seq: number,
  name: "agent.notification" | "agent.error",
  value: Loose
): ThreadStoreState => {
  const key = noticeKey({ seq, value });
  const notice: Notice = { key, seq, name, value };
  const rest = state.notices.filter((item) => item.key !== key);
  return { ...state, notices: [...rest, notice] };
};

const applySessionCustom = (
  state: ThreadStoreState,
  seq: number,
  name: string,
  value: Loose
): ThreadStoreState => {
  if (name.startsWith("permission."))
    return applyPermissionEvent(state, name, value);
  switch (name) {
    case "queue.updated":
      return applyQueueUpdated(state, value);
    case "queue.command_rejected": {
      if (value.incarnation !== state.incarnation) return state;
      const entryId = String(value.entryId ?? "");
      const command = value.command === "remove" ? "remove" : "update";
      const reason =
        value.reason === "incarnation" ? "incarnation" : "not_found";
      return {
        ...state,
        queueCommands: {
          ...state.queueCommands,
          [entryId]: {
            state: "rejected",
            command,
            reason,
            since: Date.now(),
          },
        },
      };
    }
    case "agent.status":
      return {
        ...state,
        activity: {
          ...state.activity,
          status: (value.status as ThreadStoreState["activity"]["status"]) ?? null,
        },
      };
    case "agent.heartbeat":
      return {
        ...state,
        activity: {
          ...state.activity,
          runningTools: Number(value.runningTools ?? 0),
        },
      };
    case "agent.notification":
    case "agent.error":
      return applyNotice(state, seq, name, value);
    case "session.ready":
    case "wire.hello": {
      const incarnation =
        typeof value.incarnation === "string" ? value.incarnation : null;
      if (incarnation == null || incarnation === state.incarnation)
        return state;
      return {
        ...state,
        incarnation,
        permissions: {
          items: state.permissions.items.filter(
            (item) => item.metadata.abacus.lineage.incarnation === incarnation
          ),
          answering: {},
        },
        queueCommands: {},
      };
    }
    case "skills.loaded":
      return {
        ...state,
        skills: Array.isArray(value.skills)
          ? (value.skills as ThreadStoreState["skills"])
          : [],
      };
    default:
      return state;
  }
};

const applyRunCustom = (
  state: ThreadStoreState,
  event: StreamChunk,
  name: string,
  value: Loose
): ThreadStoreState => {
  switch (name) {
    case "tool.output": {
      const key = toolKey(subagentOf(event), String(value.toolCallId ?? ""));
      return {
        ...state,
        tools: {
          ...state.tools,
          output: { ...state.tools.output, [key]: String(value.output ?? "") },
        },
      };
    }
    case "tool.display": {
      const key = toolKey(subagentOf(event), String(value.toolCallId ?? ""));
      const data = (value.data ?? {}) as Loose;
      return {
        ...state,
        tools: {
          ...state.tools,
          display: {
            ...state.tools.display,
            [key]: { ...state.tools.display[key], ...data },
          },
        },
      };
    }
    case "agent.retry":
      return {
        ...state,
        activity: {
          ...state.activity,
          retry: {
            attempt: Number(value.attempt ?? 0),
            maxAttempts: Number(value.maxAttempts ?? 0),
            delayMs: Number(value.delayMs ?? 0),
            isNetworkError: value.isNetworkError === true,
          },
        },
      };
    default:
      return state;
  }
};

const withoutKey = <T>(
  record: Record<ToolKey, T>,
  key: ToolKey
): Record<ToolKey, T> => {
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest as Record<ToolKey, T>;
};

const applyState = (
  state: ThreadStoreState,
  event: StreamChunk
): ThreadStoreState => {
  if (event.type === "STATE_SNAPSHOT") {
    const agent = (event as { snapshot?: unknown }).snapshot as AgentState;
    return {
      ...state,
      agent,
      incarnation: agent?.incarnation ?? state.incarnation,
    };
  }
  if (state.agent == null) return state;
  const ops = ((event as { delta?: unknown }).delta ?? []) as PatchOp[];
  return { ...state, agent: applyPatch(state.agent, ops) };
};

/**
 * Pre-apply: everything but terminal records. `fresh` marks a message
 * whose first chunk arrived live (for the entry motion, §9.1).
 */
export const applyEvent = (
  state: ThreadStoreState,
  seq: number,
  event: StreamChunk,
  options: { live?: boolean } = {}
): ThreadStoreState => {
  if (isSessionScoped(event)) {
    if (seq <= state.sessionCursor) return state;
    if (event.type === "STATE_SNAPSHOT" || event.type === "STATE_DELTA")
      return applyState(state, event);
    return applySessionCustom(state, seq, customName(event)!, valueOf(event));
  }
  let next = state;
  if (clearsRetry(event) && state.activity.retry != null)
    next = { ...next, activity: { ...next.activity, retry: null } };
  switch (event.type) {
    case "RUN_STARTED": {
      const meta = (event as { metadata?: { abacus?: Loose } }).metadata;
      return {
        ...next,
        runs: {
          ...next.runs,
          active: {
            runId: (event as { runId?: string }).runId ?? "",
            startedAt: eventTime(
              event,
              next.runs.active?.startedAt ?? Date.now()
            ),
            serverInitiated: meta?.abacus?.serverInitiated === true,
          },
        },
        tools: { output: {}, display: {} },
        activity: { ...next.activity, retry: null },
      };
    }
    case "TEXT_MESSAGE_START":
      if (options.live !== true) return next;
      return {
        ...next,
        fresh: {
          ...next.fresh,
          [(event as { messageId?: string }).messageId ?? ""]: true,
        },
      };
    case "TOOL_CALL_RESULT": {
      const key = toolKey(
        subagentOf(event),
        (event as { toolCallId?: string }).toolCallId ?? ""
      );
      return {
        ...next,
        tools: { ...next.tools, output: withoutKey(next.tools.output, key) },
      };
    }
    case "CUSTOM":
      return applyRunCustom(next, event, customName(event)!, valueOf(event));
    default:
      return next;
  }
};

const isToolCallPart = (part: UIMessage["parts"][number]): boolean =>
  part.type === "tool-call";

/**
 * The run's parent tool calls: tool-call parts of the assistant messages
 * after the run's user echo (children count inside their own card, §4.2).
 */
const stepsOf = (messages: readonly UIMessage[], runId: string): number => {
  let start = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      (message.id === `${runId}:user` ||
        (message.metadata as { abacus?: { runId?: string } } | undefined)
          ?.abacus?.runId === runId)
  );
  if (start === -1) start = messages.findLastIndex((m) => m.role === "user");
  return messages
    .slice(start + 1)
    .filter((message) => message.role === "assistant")
    .reduce(
      (count, message) => count + message.parts.filter(isToolCallPart).length,
      0
    );
};

/**
 * The last transcript message. An empty assistant message (main's
 * `<runId>:error` for a message-free failure, §14.12) is the anchor as main
 * records it; it renders nothing.
 */
const lastMessageId = (messages: readonly UIMessage[]): string | null =>
  messages.at(-1)?.id ?? null;

/** Post-apply: the terminal's durable outcome (§14.7), `active = null`. */
export const recordTerminal = (
  state: ThreadStoreState,
  event: StreamChunk,
  messages: readonly UIMessage[],
  now = Date.now()
): ThreadStoreState => {
  const runId = terminalRunId(event) ?? state.runs.active?.runId ?? "";
  if (state.runs.outcomes.some((outcome) => outcome.runId === runId))
    return { ...state, runs: { ...state.runs, active: null } };
  const typed = event as {
    outcome?: { type?: string };
    usage?: RunOutcomeRecord["usage"][];
    code?: string;
    message?: string;
    metadata?: { abacus?: { error?: Loose } };
  };
  const kind: RunOutcomeRecord["kind"] =
    event.type === "RUN_ERROR"
      ? "error"
      : typed.outcome?.type === "cancelled"
        ? "cancelled"
        : "success";
  const record: RunOutcomeRecord = {
    runId,
    kind,
    startedAt: state.runs.active?.startedAt ?? now,
    endedAt: eventTime(event, now),
    steps: stepsOf(messages, runId),
    afterMessageId: lastMessageId(messages),
    ...(Array.isArray(typed.usage) && typed.usage[0] != null
      ? { usage: typed.usage[0] }
      : {}),
    ...(kind === "error"
      ? {
          error: {
            message: typed.message ?? "",
            ...(typed.metadata?.abacus?.error as object | undefined),
            ...(typed.code != null ? { code: typed.code } : {}),
          } as RunOutcomeRecord["error"],
        }
      : {}),
  };
  return {
    ...state,
    runs: { active: null, outcomes: [...state.runs.outcomes, record] },
    activity: { ...state.activity, retry: null },
  };
};
