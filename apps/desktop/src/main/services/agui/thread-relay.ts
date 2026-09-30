/**
 * One thread's side of main's AG-UI relay (agent spec §5.2-§5.3, spec 02
 * §14). Every AG-UI line an agui runtime writes for the thread is applied
 * here, synchronously and in order, to every structure below before any
 * subscriber sees it:
 *
 * - a TanStack `StreamProcessor`, whose messages at each terminal are the
 *   thread's transcript (persisted, with the run's outcome record). Each
 *   chunk goes through `restoreInboundChunk` first, as `ChatClient` does, so
 *   main's transcript and a client's never differ by that step;
 * - a bounded ring of recent events for `lastEventId` resume;
 * - the active run's log (from `RUN_STARTED` to its terminal) for `joinRun`,
 *   and, for a short while, the logs of the last few finished runs;
 * - the session-scoped state `hydrate` returns (permissions, queue, agent
 *   state, skills, activity, notices, incarnation).
 *
 * Because it is all one synchronous turn per event, a checkpoint (`hydrate`)
 * and a replay (`joinRun`, `subscribe`) taken together can neither lose nor
 * double an event (agent spec §5.3 item 3).
 *
 * Main also owns what the agent cannot know across its own restarts (PLAN
 * amendments, agent spec §3.1.4, §3.8):
 *
 * - a user message id the transcript already holds is not replayed into it
 *   again; `CUSTOM abacus.duplicate_echo` says so, so a client waiting for
 *   that echo (the chat kit's outbox, spec 02 §3.7) stops waiting;
 * - a run the process never closed gets a synthesized `RUN_ERROR` (first
 *   terminal wins; the rest of that run's stream is dropped);
 * - before any `RUN_ERROR` it applies (the agent's or its own), the run's
 *   open parts are closed (text, reasoning, tool calls with an unfinished
 *   result, sub-agents) and a run with no assistant message gets an empty
 *   one: a receive-only `StreamProcessor` handles neither on `RUN_ERROR`,
 *   and without an assistant message it creates a pending one that the next
 *   run's user echo is renamed into.
 */
import {
  getChunkRunId,
  StreamProcessor,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { restoreInboundChunk } from "@tanstack/ai/client";

import {
  AgentStatus,
  type QueueEntry,
  type SkillMetadata,
} from "#shared/agent-types";
import type {
  AgentState,
  AiActiveRun,
  AiNotice,
  AiThreadSnapshot,
  PermissionDescriptor,
  RunOutcomeRecord,
} from "#shared/contract";

import { applyJsonPatch, type JsonPatchOp } from "./json-patch";

/** An AG-UI event as parsed from the agent's stdout. */
export type RelayEvent = Record<string, unknown> & { type: string };

export interface RelayChunk {
  seq: number;
  event: StreamChunk;
}

/** Recent events kept for `lastEventId` resume (completed runs and idle traffic). */
export const RING_EVENTS = 4_000;
/** The active run's log is complete up to this; then `tool.output` coalesces. */
export const ACTIVE_LOG_CAP = 200_000;
/** Finished runs whose logs stay joinable (a late `joinRun` after a terminal). */
export const FINISHED_LOGS_KEPT = 4;
/**
 * Events kept across a thread's finished logs; the newest log is kept
 * whatever its size, the older ones only within this budget.
 */
const FINISHED_EVENTS_KEPT = 20_000;
/**
 * How long a finished log stays joinable. A `joinRun` for it comes right
 * after a `hydrate` that saw the run active; after this, `hydrate` has the
 * run in the transcript.
 */
export const FINISHED_LOG_TTL_MS = 2 * 60_000;
/** Run outcomes kept in the thread file. */
export const RUN_OUTCOMES_KEPT = 1_000;
const NOTICES_KEPT = 50;
/** `ai.send` user message ids awaiting their run's start. */
const EXPECTED_ECHOES_KEPT = 256;

/** CUSTOM names that belong to a run (agent spec §2.3, *R*). */
const RUN_SCOPED_CUSTOM = new Set([
  "agent.retry",
  "tool.output",
  "tool.display",
  "queue.steered",
  "queue.dequeued",
]);

const RUN_SCOPED_PREFIXES = [
  "TEXT_MESSAGE_",
  "REASONING_",
  "TOOL_CALL_",
  "SUBAGENT_",
];

export const isRunScoped = (event: RelayEvent): boolean =>
  event.type === "CUSTOM"
    ? RUN_SCOPED_CUSTOM.has(String(event.name))
    : RUN_SCOPED_PREFIXES.some((prefix) => event.type.startsWith(prefix));

export const isTerminal = (event: { type: string }): boolean =>
  event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";

/**
 * A terminal's run id, as TanStack reads it (`getChunkRunId`): the top-level
 * `runId`, else `metadata.tanstack.runId`.
 */
export const terminalRunId = (event: RelayEvent): string | null =>
  getChunkRunId(event as unknown as StreamChunk) ?? null;

const record = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const stringOr = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** What a reply the user never sees says (the bot loop's silent answer). */
export const NO_REPLY = "NO_REPLY";

/**
 * Whether `messages` (a run's own) hold an assistant text part a user sees:
 * trimmed, non-empty and not exactly `NO_REPLY` (spec 03 §24.11).
 */
export const hasVisibleAssistantText = (
  messages: readonly UIMessage[]
): boolean =>
  messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => {
        if (part.type !== "text") return false;
        const text = String(
          (part as { content?: unknown }).content ?? ""
        ).trim();
        return text !== "" && text !== NO_REPLY;
      })
  );

/**
 * A run's authoritative end (spec 03 §24.11): the first terminal the relay
 * applied for it, once per run id, main's own included.
 */
export interface RunFinishedInfo {
  runId: string;
  outcome: "success" | "cancelled" | "error";
  errorCode?: string;
  hasVisibleAssistantText: boolean;
  /** The terminal's relay seq: the notice's event id. */
  seq: number;
  at: number;
}

/**
 * The thread's answerable pending permissions (spec 06 §23.6): the live
 * incarnation's only.
 */
export interface PendingPermissionsInfo {
  incarnation: string | null;
  items: PermissionDescriptor[];
}

/** Where seqs come from: one counter for every thread, never reused. */
export class SeqClock {
  #value = 0;

  get current(): number {
    return this.#value;
  }

  next(): number {
    this.#value += 1;
    return this.#value;
  }
}

export interface ThreadHistory {
  messages: UIMessage[];
  runs: RunOutcomeRecord[];
  migratedFrom?: { updatedAt: string };
  /**
   * The messages come from a v1 transcript (not an `agui` file): the legacy
   * renderer may still be writing it, so the relay re-reads it before the
   * thread's first AG-UI run and at each checkpoint until then.
   */
  v1Derived?: boolean;
}

export interface ThreadRelayOptions {
  threadId: string;
  clock: SeqClock;
  epoch: string;
  history: ThreadHistory;
  /** Writes the transcript and outcomes at a terminal. */
  persist: (history: ThreadHistory) => void;
  /** Deletes the thread file (`session.cleared`). */
  remove: () => void;
  /** Re-reads the thread's history (a v1-derived baseline's refresh). */
  reload?: () => ThreadHistory | null;
  /** A run's log is no longer joinable here (expired, evicted or cleared). */
  onRunForgotten?: (runId: string) => void;
  /** A run reached its authoritative terminal (once per run id). */
  onRunFinished?: (info: RunFinishedInfo) => void;
  /** The answerable pending permissions may have changed. */
  onPendingChanged?: (pending: PendingPermissionsInfo) => void;
  /** Overrides `ACTIVE_LOG_CAP` (tests). */
  activeLogCap?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** What a run has opened and not yet closed, for a terminal main applies. */
interface OpenParts {
  /** Text messages: id → the child that owns it, if any. */
  texts: Map<string, string | undefined>;
  reasoning: Map<string, { messageOpen: boolean; child: string | undefined }>;
  /** Tool calls without a result: id → owner and whether TOOL_CALL_END came. */
  tools: Map<string, { child: string | undefined; ended: boolean }>;
  /** Sub-agents without a terminal, in start order. */
  children: Set<string>;
  /** A parent assistant `TEXT_MESSAGE_START` was applied in this run. */
  hadAssistant: boolean;
}

interface ActiveRun extends AiActiveRun {
  historyEpoch: number;
  steps: number;
  /** The run's log; null holes are coalesced `tool.output`s (past the cap). */
  log: Array<RelayChunk | null>;
  live: number;
  /** The log reached the cap: from then on, tool output coalesces. */
  coalescing: boolean;
  /** tool.output log indexes per `(subagentRunId, toolCallId)`. */
  outputs: Map<string, number[]>;
  open: OpenParts;
  /** User message ids whose echo is being skipped (already in the transcript). */
  skippedUserIds: Set<string>;
  /** User message ids `abacus.duplicate_echo` was sent for in this run. */
  noticedEchoes: Set<string>;
  /** Message ids the transcript held when the run started. */
  priorMessageIds: Set<string>;
}

interface FinishedLog {
  log: RelayChunk[];
  endedAt: number;
}

type Listener = (chunk: RelayChunk) => void;

const outputKey = (event: RelayEvent): string =>
  `${String(event.subagentRunId ?? "")}\u0000${String(record(event.value).toolCallId ?? "")}`;

const unfinishedResult = (toolCallId: string): RelayEvent => {
  const text = "The run ended before this finished.";
  return {
    type: "TOOL_CALL_RESULT",
    messageId: `${toolCallId}:result`,
    toolCallId,
    role: "tool",
    content: JSON.stringify({
      text,
      rejected: true,
      error: text,
      unfinished: true,
    }),
    metadata: {
      tanstack: { state: "output-error", toolResultOutcome: "cancelled" },
    },
  };
};

export class ThreadRelay {
  readonly threadId: string;
  /** The agui runtime (its child process) feeding this thread, if any. */
  runtime: object | null = null;
  incarnation: string | null = null;

  readonly #clock: SeqClock;
  readonly #epoch: string;
  readonly #persist: (history: ThreadHistory) => void;
  readonly #remove: () => void;
  readonly #reload: (() => ThreadHistory | null) | undefined;
  readonly #onRunForgotten: (runId: string) => void;
  readonly #onRunFinished: (info: RunFinishedInfo) => void;
  readonly #onPendingChanged: (pending: PendingPermissionsInfo) => void;
  readonly #activeLogCap: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #processor: StreamProcessor;
  #transcript: UIMessage[];
  #runs: RunOutcomeRecord[];
  #migratedFrom: { updatedAt: string } | undefined;
  #v1Derived: boolean;
  /** Bumped by every clear; a run from before a clear persists nothing. */
  #historyEpoch = 0;

  #ring: RelayChunk[] = [];
  /** A resume point below this is no longer in the ring. */
  #floor: number;
  /** The seq of the last event applied to this thread (the checkpoint cursor). */
  #lastSeq: number;
  #active: ActiveRun | null = null;
  readonly #finished = new Map<string, FinishedLog>();
  /** A run main closed itself; its own late stream is dropped. */
  #orphanRunId: string | null = null;
  /** runId → the newest user message id `ai.send` sent for it. */
  readonly #expectedEchoes = new Map<string, string>();

  #permissions: { incarnation: string | null; items: PermissionDescriptor[] } =
    { incarnation: null, items: [] };
  #queue: QueueEntry[] = [];
  #agent: AgentState | null = null;
  #skills: SkillMetadata[] = [];
  #activity: { status: AgentStatus; runningTools: number } = {
    status: AgentStatus.Idle,
    runningTools: 0,
  };
  #notices: AiNotice[] = [];
  /** The answerable set last reported (`#checkPending`); "" for none. */
  #pendingKey = "";

  readonly #listeners = new Set<Listener>();
  /** Last time anything touched this thread, for eviction. */
  lastUsed: number;

  constructor(options: ThreadRelayOptions) {
    this.threadId = options.threadId;
    this.#clock = options.clock;
    this.#epoch = options.epoch;
    this.#persist = options.persist;
    this.#remove = options.remove;
    this.#reload = options.reload;
    this.#onRunForgotten = options.onRunForgotten ?? (() => undefined);
    this.#onRunFinished = options.onRunFinished ?? (() => undefined);
    this.#onPendingChanged = options.onPendingChanged ?? (() => undefined);
    this.#activeLogCap = options.activeLogCap ?? ACTIVE_LOG_CAP;
    this.#now = options.now ?? Date.now;
    this.#log =
      options.log ?? ((message) => console.error(`[agui] ${message}`));
    this.#transcript = structuredClone(options.history.messages);
    this.#runs = [...options.history.runs];
    this.#migratedFrom = options.history.migratedFrom;
    this.#v1Derived = options.history.v1Derived === true;
    this.#processor = new StreamProcessor({
      initialMessages: structuredClone(options.history.messages),
    });
    this.#floor = this.#clock.current;
    this.#lastSeq = this.#floor;
    this.lastUsed = this.#now();
  }

  get activeRunId(): string | null {
    return this.#active?.runId ?? null;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Whether `runId` ran in this thread and has ended (its log may be gone). */
  hasFinished(runId: string): boolean {
    return (
      this.#finished.has(runId) ||
      this.#runs.some((outcome) => outcome.runId === runId)
    );
  }

  /** The latest host queue, hidden entries included. */
  get queue(): readonly QueueEntry[] {
    return this.#queue;
  }

  /**
   * `ai.send` wrote `run` for `runId` with `messageId` as its newest user
   * message. If the transcript already holds that id when the run starts (a
   * retry, which the agent does not echo again in the same process), the
   * relay says `abacus.duplicate_echo` for it.
   */
  expectEcho(runId: string, messageId: string): void {
    this.#expectedEchoes.set(runId, messageId);
    while (this.#expectedEchoes.size > EXPECTED_ECHOES_KEPT)
      this.#expectedEchoes.delete(this.#expectedEchoes.keys().next().value!);
  }

  /**
   * Applies one event from the agent. Returns the sequenced chunk, or null
   * when the event is dropped (a stray run-scoped event, a closed run's
   * tail, a user echo the transcript already holds).
   */
  ingest(event: RelayEvent, runtime: object | null = null): RelayChunk | null {
    this.lastUsed = this.#now();
    this.#pruneFinished();

    if (event.type === "CUSTOM" && event.name === "wire.hello") {
      const value = record(event.value);
      // A process that never closed its run is gone: close it first.
      if (this.#active != null && this.runtime !== runtime)
        this.#synthesizeTerminal(
          "agent_exit",
          "The agent restarted before the reply finished."
        );
      this.runtime = runtime;
      if (typeof value.incarnation === "string")
        this.#setIncarnation(value.incarnation);
    }

    if (event.type === "RUN_STARTED") {
      if (this.#active != null)
        this.#synthesizeTerminal(
          "agent_exit",
          "The run ended without a terminal."
        );
      this.#orphanRunId = null;
      // The last chance to pick up legacy turns before AG-UI history starts.
      this.#refreshBaseline();
      const chunk = this.#apply(event);
      this.#noticeExpectedEcho();
      return chunk;
    }

    if (isTerminal(event)) {
      const runId = terminalRunId(event);
      if (
        this.#active == null ||
        (runId != null && runId !== this.#active.runId)
      ) {
        // A run main already closed: first terminal wins.
        if (runId != null && runId === this.#orphanRunId)
          this.#orphanRunId = null;
        return null;
      }
      if (event.type === "RUN_ERROR") this.#closeOpenParts(this.#active);
    } else if (isRunScoped(event)) {
      const active = this.#active;
      if (active == null) return null;
      const skip = this.#skipUserEcho(active, event);
      if (skip !== "keep") {
        if (skip === "notice")
          this.#apply(
            this.#custom("abacus.duplicate_echo", {
              runId: active.runId,
              messageId: event.messageId,
            })
          );
        return null;
      }
    }

    return this.#apply(event);
  }

  /**
   * Main's own terminal for the open run (a signal exit, the inactivity
   * watchdog): first terminal wins, and the agent's later stream for that run
   * is dropped. Null when no run is open.
   */
  failActiveRun(code: string, message: string): RelayChunk | null {
    return this.#synthesizeTerminal(code, message);
  }

  /**
   * The runtime is gone (`runtime` exited): close its run, and say the
   * process-bound state it held is gone with it (its pending permissions,
   * its queue, its activity), so every window drops them. False when
   * `runtime` is no longer the thread's (a replacement already runs).
   */
  runtimeExited(
    runtime: object,
    code: "agent_exit" | "agent_crashed",
    message: string
  ): boolean {
    if (this.runtime != null && this.runtime !== runtime) return false;
    this.#synthesizeTerminal(code, message);
    if (this.#permissions.items.length > 0)
      this.#apply(
        this.#custom("permission.pending", {
          incarnation: this.#permissions.incarnation ?? this.incarnation ?? "",
          items: [],
        })
      );
    if (this.#queue.length > 0)
      this.#apply(
        this.#custom("queue.updated", { messages: [], dequeued: null })
      );
    if (this.#activity.status !== AgentStatus.Idle)
      this.#apply(this.#custom("agent.status", { status: AgentStatus.Idle }));
    // No process is left to correct a count of running tools.
    if (this.#activity.runningTools !== 0)
      this.#apply(this.#custom("agent.heartbeat", { runningTools: 0 }));
    this.runtime = null;
    return true;
  }

  /**
   * A queue command main refused before it reached the agent (spec 02 §14.6):
   * on the stream, then the authoritative queue, as the agent would.
   */
  rejectQueueCommand(
    entryId: string,
    command: "update" | "remove",
    reason: "incarnation" | "not_found"
  ): void {
    this.#apply(
      this.#custom("queue.command_rejected", {
        incarnation: this.incarnation ?? "",
        entryId,
        command,
        reason,
      })
    );
    this.#apply(
      this.#custom("queue.updated", {
        messages: this.#queue,
        dequeued: null,
      })
    );
  }

  /**
   * The conversation was cleared by main (legacy reset, session deletion):
   * a `session.cleared` of main's own, so every window drops its transcript
   * (spec 02 §3.1 `rev`) as it does for the agent's. The agent's own
   * `session.cleared`, if it comes, clears again.
   *
   * A run still open is retired first, as the agent's reset does (its
   * cancelled terminal precedes the clear): its open parts close, it
   * finishes `cancelled` without persisting, and the rest of its stream is
   * dropped. So nothing after the clear belongs to it: `hydrate` answers
   * `activeRun: null`, `joinRun` has no log for it, and a client's new
   * generation (spec 02 §3.3) never replays the clear it is recovering from.
   */
  clearByMain(): void {
    const active = this.#active;
    if (active != null) {
      // It belongs to the history being cleared: its terminal persists nothing.
      this.#historyEpoch += 1;
      this.#closeOpenParts(active, { anchor: false });
      this.#apply({
        type: "RUN_FINISHED",
        threadId: this.threadId,
        runId: active.runId,
        outcome: { type: "cancelled" },
        timestamp: Date.now(),
      });
      this.#orphanRunId = active.runId;
    }
    this.#apply(this.#custom("session.cleared", {}));
  }

  /** The atomic checkpoint (agent spec §5.3 item 3; spec 02 §14.1). */
  checkpoint(): {
    messages: UIMessage[];
    activeRun: { runId: string } | null;
    snapshot: AiThreadSnapshot;
  } {
    this.lastUsed = this.#now();
    this.#pruneFinished();
    this.#refreshBaseline();
    const active = this.#active;
    const activeRun: AiActiveRun | null =
      active == null
        ? null
        : {
            runId: active.runId,
            startSeq: active.startSeq,
            startedAt: active.startedAt,
            serverInitiated: active.serverInitiated,
          };

    return {
      messages: structuredClone(this.#transcript),
      activeRun: activeRun == null ? null : { runId: activeRun.runId },
      snapshot: {
        // This thread's own last seq: every event up to it is either in the
        // snapshot or in the active run's replay, whatever other threads did.
        cursor: this.#lastSeq,
        epoch: this.#epoch,
        incarnation: this.incarnation,
        activeRun,
        // Dead incarnations are dropped (agent spec §5.3 item 6).
        permissions: this.#permissions.items.filter(
          (item) =>
            this.incarnation == null ||
            item.metadata.abacus.lineage.incarnation === this.incarnation
        ),
        queue: this.#queue.filter((entry) => entry.hidden !== true),
        agent: this.#agent == null ? null : structuredClone(this.#agent),
        skills: [...this.#skills],
        activity: { ...this.#activity },
        notices: [...this.#notices],
        runOutcomes: [...this.#runs],
      },
    };
  }

  /**
   * Registers `listener` and returns what it must replay first, in one
   * synchronous turn: events with seq `> afterSeq` (null: the whole ring), or
   * `"resync"` when the ring no longer holds that point.
   */
  subscribe(
    afterSeq: number | null,
    listener: Listener
  ): { replay: RelayChunk[] | "resync"; unsubscribe: () => void } {
    this.lastUsed = this.#now();
    this.#listeners.add(listener);
    const unsubscribe = (): void => {
      this.#listeners.delete(listener);
    };
    if (afterSeq == null) return { replay: [...this.#ring], unsubscribe };
    if (afterSeq < this.#floor || afterSeq > this.#clock.current)
      return { replay: "resync", unsubscribe };

    return {
      replay: this.#ring.filter((chunk) => chunk.seq > afterSeq),
      unsubscribe,
    };
  }

  /**
   * `joinRun`: the run's log from its `RUN_STARTED` (to its terminal when it
   * has ended), with `listener` registered in the same turn for the rest.
   * Null for a run this thread cannot replay.
   */
  joinRun(
    runId: string,
    listener: Listener
  ): { replay: RelayChunk[]; ended: boolean; unsubscribe: () => void } | null {
    this.lastUsed = this.#now();
    this.#pruneFinished();
    const finished = this.#finished.get(runId);
    if (finished != null)
      return { replay: [...finished.log], ended: true, unsubscribe: () => {} };
    if (this.#active?.runId !== runId) return null;
    this.#listeners.add(listener);

    return {
      replay: this.#activeLog(this.#active),
      ended: false,
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /** Drops finished logs past their budget or grace period. */
  sweep(): void {
    this.#pruneFinished();
  }

  // ─── internals ─────────────────────────────────────────────────────────

  #custom(name: string, value: unknown): RelayEvent {
    return { type: "CUSTOM", name, value, timestamp: Date.now() };
  }

  #setIncarnation(incarnation: string): void {
    if (this.incarnation === incarnation) return;
    this.incarnation = incarnation;
    // Another process's descriptors and queue ids mean nothing to this one.
    if (this.#permissions.incarnation !== incarnation)
      this.#permissions = { incarnation, items: [] };
    this.#queue = [];
  }

  /**
   * A v1-derived baseline is re-read while no AG-UI run has persisted: the
   * legacy renderer's turns (an ndjson runtime) keep landing in the v1 file,
   * and the first AG-UI terminal must not persist a stale copy over them.
   */
  #refreshBaseline(): void {
    if (!this.#v1Derived || this.#active != null || this.#reload == null)
      return;
    let next: ThreadHistory | null;
    try {
      next = this.#reload();
    } catch (error) {
      this.#log(
        `${this.threadId}: re-reading the thread file failed: ${String(error)}`
      );
      return;
    }
    if (next == null) return;
    if (
      next.v1Derived === true &&
      next.migratedFrom?.updatedAt === this.#migratedFrom?.updatedAt
    )
      return;
    this.#transcript = structuredClone(next.messages);
    this.#processor = new StreamProcessor({
      initialMessages: structuredClone(next.messages),
    });
    this.#migratedFrom = next.migratedFrom;
    this.#v1Derived = next.v1Derived === true;
    if (!this.#v1Derived) this.#runs = [...next.runs];
  }

  /**
   * A user `TEXT_MESSAGE_*` whose id the transcript already holds: a retry
   * after a respawn (agent spec §3.1.4, §5.2). `StreamProcessor` would append
   * its content to the stored message ("questionquestion"), in main's
   * transcript and in every client replaying the ring, so it is dropped;
   * its START is answered with `abacus.duplicate_echo` ("notice").
   */
  #skipUserEcho(
    active: ActiveRun,
    event: RelayEvent
  ): "keep" | "drop" | "notice" {
    const messageId =
      typeof event.messageId === "string" ? event.messageId : null;
    if (messageId == null) return "keep";
    if (event.type === "TEXT_MESSAGE_START") {
      if (
        event.role === "user" &&
        this.#processor
          .getMessages()
          .some((message) => message.id === messageId)
      ) {
        active.skippedUserIds.add(messageId);
        if (active.noticedEchoes.has(messageId)) return "drop";
        active.noticedEchoes.add(messageId);
        return "notice";
      }
      return "keep";
    }
    if (!active.skippedUserIds.has(messageId)) return "keep";
    if (event.type === "TEXT_MESSAGE_END")
      active.skippedUserIds.delete(messageId);
    return event.type.startsWith("TEXT_MESSAGE_") ? "drop" : "keep";
  }

  /** The run `ai.send` started holds a user message the transcript already has. */
  #noticeExpectedEcho(): void {
    const active = this.#active;
    if (active == null) return;
    const messageId = this.#expectedEchoes.get(active.runId);
    this.#expectedEchoes.delete(active.runId);
    if (
      messageId == null ||
      !this.#processor.getMessages().some((message) => message.id === messageId)
    )
      return;
    active.noticedEchoes.add(messageId);
    this.#apply(
      this.#custom("abacus.duplicate_echo", {
        runId: active.runId,
        messageId,
      })
    );
  }

  #synthesizeTerminal(code: string, message: string): RelayChunk | null {
    const active = this.#active;
    if (active == null) return null;
    this.#closeOpenParts(active);
    const chunk = this.#apply({
      type: "RUN_ERROR",
      message,
      code,
      metadata: {
        tanstack: { threadId: this.threadId, runId: active.runId },
        abacus: { error: { message, code } },
      },
      timestamp: Date.now(),
    });
    this.#orphanRunId = active.runId;
    return chunk;
  }

  /**
   * Before a `RUN_ERROR`: the run's open parts closed in the agent's order
   * (agent spec §3.1.5, `closeOpenParts`), then an empty assistant message
   * when the run has none (`anchor`; a cancelled terminal needs none).
   * Nothing when the agent already did both.
   */
  #closeOpenParts(active: ActiveRun, options = { anchor: true }): void {
    const { texts, reasoning, tools, children, hadAssistant } = active.open;
    const out: RelayEvent[] = [];
    const tag = (event: RelayEvent, child: string | undefined): RelayEvent =>
      child == null ? event : { ...event, subagentRunId: child };
    const closeTexts = (owner: (child: string | undefined) => boolean) => {
      for (const [messageId, child] of texts)
        if (owner(child))
          out.push(tag({ type: "TEXT_MESSAGE_END", messageId }, child));
    };
    const closeTools = (owner: (child: string | undefined) => boolean) => {
      for (const [toolCallId, tool] of tools) {
        if (!owner(tool.child)) continue;
        if (!tool.ended)
          out.push(tag({ type: "TOOL_CALL_END", toolCallId }, tool.child));
        out.push(tag(unfinishedResult(toolCallId), tool.child));
      }
    };

    for (const [messageId, open] of reasoning) {
      if (open.messageOpen)
        out.push(tag({ type: "REASONING_MESSAGE_END", messageId }, open.child));
      out.push(tag({ type: "REASONING_END", messageId }, open.child));
    }
    closeTexts((child) => child == null);
    // Innermost (latest started) child first: its parts, then its terminal.
    for (const child of [...children].reverse()) {
      closeTexts((owner) => owner === child);
      closeTools((owner) => owner === child);
      out.push({
        type: "SUBAGENT_ERROR",
        subagentRunId: child,
        message: "The sub-agent did not finish.",
        code: "unfinished",
      });
    }
    // Parts of children that already ended.
    closeTexts((child) => child != null && !children.has(child));
    closeTools((child) => child != null && !children.has(child));
    closeTools((child) => child == null);
    if (!hadAssistant && options.anchor) {
      let messageId = `${active.runId}:error`;
      const taken = new Set(
        this.#processor.getMessages().map((message) => message.id)
      );
      for (let n = 2; taken.has(messageId); n += 1)
        messageId = `${active.runId}:error:${n}`;
      out.push(
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_END", messageId }
      );
    }

    for (const event of out) this.#apply(event);
  }

  /** What a run-scoped event opens or closes. */
  #track(open: OpenParts, event: RelayEvent): void {
    const child = stringOr(event.subagentRunId);
    const messageId = stringOr(event.messageId);
    const toolCallId = stringOr(event.toolCallId);
    switch (event.type) {
      case "TEXT_MESSAGE_START":
        if (messageId != null) open.texts.set(messageId, child);
        if (child == null && event.role !== "user" && event.role !== "system")
          open.hadAssistant = true;
        return;
      case "TEXT_MESSAGE_END":
        if (messageId != null) open.texts.delete(messageId);
        return;
      case "REASONING_START":
        if (messageId != null)
          open.reasoning.set(messageId, { messageOpen: false, child });
        return;
      case "REASONING_MESSAGE_START":
        if (messageId != null)
          open.reasoning.set(messageId, { messageOpen: true, child });
        return;
      case "REASONING_MESSAGE_END": {
        const reasoning =
          messageId == null ? undefined : open.reasoning.get(messageId);
        if (reasoning != null) reasoning.messageOpen = false;
        return;
      }
      case "REASONING_END":
        if (messageId != null) open.reasoning.delete(messageId);
        return;
      case "TOOL_CALL_START":
        if (toolCallId != null && !open.tools.has(toolCallId))
          open.tools.set(toolCallId, { child, ended: false });
        return;
      case "TOOL_CALL_END": {
        const tool =
          toolCallId == null ? undefined : open.tools.get(toolCallId);
        if (tool != null) tool.ended = true;
        return;
      }
      case "TOOL_CALL_RESULT":
        if (toolCallId != null) open.tools.delete(toolCallId);
        return;
      case "SUBAGENT_STARTED":
        if (child != null) open.children.add(child);
        return;
      case "SUBAGENT_FINISHED":
      case "SUBAGENT_ERROR":
        if (child != null) open.children.delete(child);
        return;
      default:
        return;
    }
  }

  /** Sequences, applies and fans out one event. */
  #apply(event: RelayEvent): RelayChunk {
    const chunk: RelayChunk = {
      seq: this.#clock.next(),
      event: event as unknown as StreamChunk,
    };
    this.#lastSeq = chunk.seq;

    if (event.type === "RUN_STARTED") {
      const metadata = record(event.metadata);
      this.#active = {
        runId: String(event.runId),
        startSeq: chunk.seq,
        startedAt:
          typeof event.timestamp === "number" ? event.timestamp : Date.now(),
        serverInitiated: record(metadata.abacus).serverInitiated === true,
        historyEpoch: this.#historyEpoch,
        steps: 0,
        log: [],
        live: 0,
        coalescing: false,
        outputs: new Map(),
        open: {
          texts: new Map(),
          reasoning: new Map(),
          tools: new Map(),
          children: new Set(),
          hadAssistant: false,
        },
        skippedUserIds: new Set(),
        noticedEchoes: new Set(),
        priorMessageIds: new Set(
          this.#processor.getMessages().map((message) => message.id)
        ),
      };
    }

    try {
      // As `ChatClient.processIncomingChunk` does, on a shallow copy (it
      // assigns top-level fields only): the ring and the logs keep the
      // event as the agent wrote it.
      this.#processor.processChunk(
        restoreInboundChunk({ ...event } as unknown as StreamChunk)
      );
    } catch (error) {
      this.#log(
        `${this.threadId}: the transcript processor rejected ${event.type}: ${String(error)}`
      );
    }
    if (this.#active != null && isRunScoped(event))
      this.#track(this.#active.open, event);
    this.#applySessionState(event, chunk.seq);
    this.#checkPending(event);
    this.#record(chunk, event);
    if (isTerminal(event)) this.#finishRun(event, chunk.seq);

    // A copy: a listener may unsubscribe itself (a joined run ends).
    for (const listener of Array.from(this.#listeners)) listener(chunk);

    return chunk;
  }

  #record(chunk: RelayChunk, event: RelayEvent): void {
    this.#ring.push(chunk);
    if (this.#ring.length > RING_EVENTS) {
      const evicted = this.#ring.splice(0, this.#ring.length - RING_EVENTS);
      this.#floor = evicted[evicted.length - 1]!.seq;
    }

    const active = this.#active;
    if (active == null) return;
    if (
      event.type === "TOOL_CALL_START" &&
      (event.subagentRunId == null || event.subagentRunId === "")
    )
      active.steps += 1;
    if (active.live >= this.#activeLogCap) active.coalescing = true;
    if (event.type === "CUSTOM" && event.name === "tool.output") {
      const key = outputKey(event);
      let indexes = active.outputs.get(key);
      if (active.coalescing && indexes != null) {
        // Past the cap, live tool output coalesces to the latest per call:
        // every earlier output of that call leaves the log.
        for (const index of indexes) {
          if (active.log[index] == null) continue;
          active.log[index] = null;
          active.live -= 1;
        }
        indexes = [];
        active.outputs.set(key, indexes);
      }
      if (indexes == null) {
        indexes = [];
        active.outputs.set(key, indexes);
      }
      indexes.push(active.log.length);
    }
    active.log.push(chunk);
    active.live += 1;
    if (active.log.length - active.live > Math.max(1_024, active.live))
      this.#compact(active);
  }

  /** Drops the holes coalescing left, and re-indexes the outputs. */
  #compact(active: ActiveRun): void {
    const log = this.#activeLog(active);
    active.log = log;
    active.live = log.length;
    active.outputs.clear();
    log.forEach((chunk, index) => {
      const event = chunk.event as unknown as RelayEvent;
      if (event.type !== "CUSTOM" || event.name !== "tool.output") return;
      const key = outputKey(event);
      const indexes = active.outputs.get(key) ?? [];
      indexes.push(index);
      active.outputs.set(key, indexes);
    });
  }

  #activeLog(active: ActiveRun): RelayChunk[] {
    return active.log.filter((chunk): chunk is RelayChunk => chunk != null);
  }

  #forgetFinished(runId: string): void {
    if (this.#finished.delete(runId)) this.#onRunForgotten(runId);
  }

  #pruneFinished(): void {
    if (this.#finished.size === 0) return;
    const now = this.#now();
    for (const [runId, finished] of this.#finished)
      if (now - finished.endedAt > FINISHED_LOG_TTL_MS)
        this.#forgetFinished(runId);
    while (this.#finished.size > FINISHED_LOGS_KEPT)
      this.#forgetFinished(this.#finished.keys().next().value!);
    let events = 0;
    for (const finished of this.#finished.values())
      events += finished.log.length;
    // Oldest first; the newest log stays whatever its size.
    for (const [runId, finished] of this.#finished) {
      if (events <= FINISHED_EVENTS_KEPT || this.#finished.size <= 1) break;
      events -= finished.log.length;
      this.#forgetFinished(runId);
    }
  }

  #finishRun(event: RelayEvent, seq: number): void {
    const active = this.#active;
    if (active == null) return;
    this.#active = null;
    this.#publishFinished(active, event, seq);

    this.#finished.set(active.runId, {
      log: this.#activeLog(active),
      endedAt: this.#now(),
    });
    this.#pruneFinished();

    if (active.historyEpoch !== this.#historyEpoch) {
      // Cleared while it ran: nothing of it belongs to the new history.
      this.#processor.clearMessages();
      this.#transcript = [];
      return;
    }

    const messages = this.#processor.getMessages();
    this.#transcript = structuredClone(messages);
    const outcome = this.#outcome(active, event, messages);
    this.#runs.push(outcome);
    if (this.#runs.length > RUN_OUTCOMES_KEPT)
      this.#runs.splice(0, this.#runs.length - RUN_OUTCOMES_KEPT);

    try {
      this.#persist({
        messages: this.#transcript,
        runs: this.#runs,
        ...(this.#migratedFrom != null && { migratedFrom: this.#migratedFrom }),
      });
      // The file is now the relay's: no v1 refresh from here on.
      this.#v1Derived = false;
    } catch (error) {
      this.#log(
        `${this.threadId}: persisting the transcript failed: ${String(error)}`
      );
    }
  }

  /** The run's one notice, from the messages it added to the processor. */
  #publishFinished(active: ActiveRun, event: RelayEvent, seq: number): void {
    const own = this.#processor
      .getMessages()
      .filter((message) => !active.priorMessageIds.has(message.id));
    const outcome =
      event.type === "RUN_ERROR"
        ? "error"
        : record(event.outcome).type === "cancelled"
          ? "cancelled"
          : "success";
    const code = stringOr(event.code);
    try {
      this.#onRunFinished({
        runId: active.runId,
        outcome,
        ...(outcome === "error" && code != null && { errorCode: code }),
        hasVisibleAssistantText: hasVisibleAssistantText(own),
        seq,
        at: typeof event.timestamp === "number" ? event.timestamp : this.#now(),
      });
    } catch (error) {
      this.#log(
        `${this.threadId}: the run-finished notice failed: ${String(error)}`
      );
    }
  }

  /** The permissions a client may still answer: the live incarnation's. */
  get pendingPermissions(): PendingPermissionsInfo {
    return {
      incarnation: this.incarnation,
      items: this.#permissions.items.filter(
        (item) =>
          this.incarnation == null ||
          item.metadata.abacus.lineage.incarnation === this.incarnation
      ),
    };
  }

  /**
   * After an event that can change the answerable set (its list, or the
   * live incarnation): tells the host when the set really changed.
   */
  #checkPending(event: RelayEvent): void {
    const relevant =
      event.type === "STATE_SNAPSHOT" ||
      (event.type === "CUSTOM" &&
        (event.name === "permission.pending" ||
          event.name === "session.ready" ||
          event.name === "wire.hello"));
    if (!relevant) return;
    const pending = this.pendingPermissions;
    const key =
      pending.items.length === 0
        ? ""
        : `${pending.incarnation ?? ""}\u0000${pending.items
            .map((item) => item.metadata.abacus.lineage.permissionId)
            .join("\u0000")}`;
    if (key === this.#pendingKey) return;
    this.#pendingKey = key;
    try {
      this.#onPendingChanged(pending);
    } catch (error) {
      this.#log(
        `${this.threadId}: the attention update failed: ${String(error)}`
      );
    }
  }

  #clearHistory(): void {
    this.#historyEpoch += 1;
    this.#processor.clearMessages();
    this.#transcript = [];
    this.#runs = [];
    this.#notices = [];
    this.#migratedFrom = undefined;
    this.#v1Derived = false;
    for (const runId of this.#finished.keys()) this.#forgetFinished(runId);
  }

  #outcome(
    active: ActiveRun,
    event: RelayEvent,
    messages: UIMessage[]
  ): RunOutcomeRecord {
    const endedAt =
      typeof event.timestamp === "number" ? event.timestamp : Date.now();
    const base = {
      runId: active.runId,
      startedAt: active.startedAt,
      endedAt,
      steps: active.steps,
      afterMessageId: messages.at(-1)?.id ?? null,
    };

    if (event.type === "RUN_ERROR") {
      const abacus = record(record(event.metadata).abacus);
      const error = record(abacus.error);
      return {
        ...base,
        kind: "error",
        error: {
          ...error,
          ...(typeof event.message === "string" && { message: event.message }),
          ...(typeof event.code === "string" && { code: event.code }),
        },
      };
    }

    const outcome = record(event.outcome);
    const usage = Array.isArray(event.usage) ? event.usage[0] : undefined;
    return {
      ...base,
      kind: outcome.type === "cancelled" ? "cancelled" : "success",
      ...(usage != null && typeof usage === "object" && { usage }),
    };
  }

  /** Session-scoped slices the snapshot serves (spec 02 §14.1). */
  #applySessionState(event: RelayEvent, seq: number): void {
    if (event.type === "STATE_SNAPSHOT") {
      const snapshot = record(event.snapshot);
      this.#agent = structuredClone(snapshot) as unknown as AgentState;
      if (typeof snapshot.incarnation === "string")
        this.#setIncarnation(snapshot.incarnation);
      return;
    }
    if (event.type === "STATE_DELTA") {
      if (this.#agent == null) return;
      const next = applyJsonPatch(
        this.#agent,
        (Array.isArray(event.delta) ? event.delta : []) as JsonPatchOp[]
      );
      // A patch this subset cannot apply: hold nothing rather than a wrong state.
      this.#agent = next;
      return;
    }
    if (event.type !== "CUSTOM") return;

    const value = record(event.value);
    switch (event.name) {
      case "session.ready":
        if (typeof value.incarnation === "string")
          this.#setIncarnation(value.incarnation);
        return;
      case "session.cleared":
        this.#clearHistory();
        try {
          this.#remove();
        } catch (error) {
          this.#log(
            `${this.threadId}: removing the thread file failed: ${String(error)}`
          );
        }
        return;
      case "permission.pending":
        this.#permissions = {
          incarnation:
            typeof value.incarnation === "string" ? value.incarnation : null,
          items: Array.isArray(value.items)
            ? (value.items as PermissionDescriptor[])
            : [],
        };
        return;
      case "queue.updated":
        this.#queue = Array.isArray(value.messages)
          ? (value.messages as QueueEntry[])
          : [];
        return;
      case "skills.loaded":
        this.#skills = Array.isArray(value.skills)
          ? (value.skills as SkillMetadata[])
          : [];
        return;
      case "agent.status":
        if (typeof value.status === "string")
          this.#activity = {
            ...this.#activity,
            status: value.status as AgentStatus,
          };
        return;
      case "agent.heartbeat":
        if (typeof value.runningTools === "number")
          this.#activity = {
            ...this.#activity,
            runningTools: value.runningTools,
          };
        return;
      case "agent.notification":
      case "agent.error": {
        const key =
          typeof value.notificationKey === "string"
            ? value.notificationKey
            : null;
        if (key != null)
          this.#notices = this.#notices.filter(
            (notice) => notice.value.notificationKey !== key
          );
        this.#notices.push({ seq, name: event.name, value });
        if (this.#notices.length > NOTICES_KEPT)
          this.#notices.splice(0, this.#notices.length - NOTICES_KEPT);
        return;
      }
      default:
        return;
    }
  }
}
