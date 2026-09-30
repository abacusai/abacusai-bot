/**
 * One thread's side of main's AG-UI relay (agent spec §5.2-§5.3, spec 02
 * §14). Every AG-UI line an agui runtime writes for the thread is applied
 * here, synchronously and in order, to every structure below before any
 * subscriber sees it:
 *
 * - a TanStack `StreamProcessor`, whose messages at each terminal are the
 *   thread's transcript (persisted, with the run's outcome record);
 * - a bounded ring of recent events for `lastEventId` resume;
 * - the active run's complete log (from `RUN_STARTED`, never evicted until its
 *   terminal) for `joinRun`, and the logs of the last few finished runs;
 * - the session-scoped state `hydrate` returns (permissions, queue, agent
 *   state, skills, activity, notices, incarnation).
 *
 * Because it is all one synchronous turn per event, a checkpoint (`hydrate`)
 * and a replay (`joinRun`, `subscribe`) taken together can neither lose nor
 * double an event (agent spec §5.3 item 3).
 *
 * Main also owns what the agent cannot know across its own restarts (PLAN
 * amendments, agent spec §3.1.4, §3.8): a user message id the transcript
 * already holds is not replayed into it again, and a run the process never
 * closed gets a synthesized `RUN_ERROR` (first terminal wins; the rest of that
 * run's stream is dropped).
 */
import {
  StreamProcessor,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";

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
/** Run outcomes kept in the thread file. */
export const RUN_OUTCOMES_KEPT = 1_000;
const NOTICES_KEPT = 50;

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

/** A terminal's run id: `RUN_FINISHED.runId`, or TanStack's metadata convention. */
export const terminalRunId = (event: RelayEvent): string | null => {
  if (event.type === "RUN_FINISHED")
    return typeof event.runId === "string" ? event.runId : null;
  const runId = (
    event.metadata as { tanstack?: { runId?: unknown } } | undefined
  )?.tanstack?.runId;
  return typeof runId === "string" ? runId : null;
};

const record = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

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
  log?: (message: string) => void;
}

interface ActiveRun extends AiActiveRun {
  historyEpoch: number;
  steps: number;
  log: RelayChunk[];
}

type Listener = (chunk: RelayChunk) => void;

export class ThreadRelay {
  readonly threadId: string;
  /** The agui runtime (its child process) feeding this thread, if any. */
  runtime: object | null = null;
  incarnation: string | null = null;

  readonly #clock: SeqClock;
  readonly #epoch: string;
  readonly #persist: (history: ThreadHistory) => void;
  readonly #remove: () => void;
  readonly #log: (message: string) => void;
  #processor: StreamProcessor;
  #transcript: UIMessage[];
  #runs: RunOutcomeRecord[];
  #migratedFrom: { updatedAt: string } | undefined;
  /** Bumped by every clear; a run from before a clear persists nothing. */
  #historyEpoch = 0;

  #ring: RelayChunk[] = [];
  /** A resume point below this is no longer in the ring. */
  #floor: number;
  #active: ActiveRun | null = null;
  readonly #finished = new Map<string, RelayChunk[]>();
  /** A run main closed itself; its own late stream is dropped. */
  #orphanRunId: string | null = null;
  /** User message ids whose echo is being skipped (already in the transcript). */
  readonly #skippedUserIds = new Set<string>();

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

  readonly #listeners = new Set<Listener>();
  /** Last time anything touched this thread, for eviction. */
  lastUsed = Date.now();

  constructor(options: ThreadRelayOptions) {
    this.threadId = options.threadId;
    this.#clock = options.clock;
    this.#epoch = options.epoch;
    this.#persist = options.persist;
    this.#remove = options.remove;
    this.#log =
      options.log ?? ((message) => console.error(`[agui] ${message}`));
    this.#transcript = structuredClone(options.history.messages);
    this.#runs = [...options.history.runs];
    this.#migratedFrom = options.history.migratedFrom;
    this.#processor = new StreamProcessor({
      initialMessages: structuredClone(options.history.messages),
    });
    this.#floor = this.#clock.current;
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

  /** The latest host queue, hidden entries included (their indexes count). */
  get queue(): readonly QueueEntry[] {
    return this.#queue;
  }

  /**
   * Applies one event from the agent. Returns the sequenced chunk, or null
   * when the event is dropped (a stray run-scoped event, a closed run's
   * tail, a user echo the transcript already holds).
   */
  ingest(event: RelayEvent, runtime: object | null = null): RelayChunk | null {
    this.lastUsed = Date.now();

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
    } else if (isTerminal(event)) {
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
    } else if (isRunScoped(event)) {
      if (this.#active == null) return null;
      if (this.#skipUserEcho(event)) return null;
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
   * process-bound state it held is gone with it (its pending permissions and
   * its queue), so every window drops them.
   */
  runtimeExited(
    runtime: object,
    code: "agent_exit" | "agent_crashed",
    message: string
  ): void {
    if (this.runtime != null && this.runtime !== runtime) return;
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
    if (
      this.#activity.status !== AgentStatus.Idle ||
      this.#activity.runningTools !== 0
    )
      this.#apply(this.#custom("agent.status", { status: AgentStatus.Idle }));
    this.runtime = null;
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
   * The conversation was cleared by main (legacy reset, session deletion).
   * History goes at once; a run still open finishes without persisting, and
   * the agent's `session.cleared` clears again when it lands.
   */
  clearHistory(): void {
    this.#historyEpoch += 1;
    this.#processor.clearMessages();
    this.#transcript = [];
    this.#runs = [];
    this.#notices = [];
    this.#migratedFrom = undefined;
    this.#finished.clear();
  }

  /** The atomic checkpoint (agent spec §5.3 item 3; spec 02 §14.1). */
  checkpoint(): {
    messages: UIMessage[];
    activeRun: { runId: string } | null;
    snapshot: AiThreadSnapshot;
  } {
    this.lastUsed = Date.now();
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
        cursor: this.#clock.current,
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
    this.lastUsed = Date.now();
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
    this.lastUsed = Date.now();
    const finished = this.#finished.get(runId);
    if (finished != null)
      return { replay: [...finished], ended: true, unsubscribe: () => {} };
    if (this.#active?.runId !== runId) return null;
    this.#listeners.add(listener);

    return {
      replay: [...this.#active.log],
      ended: false,
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
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
   * A user `TEXT_MESSAGE_*` whose id the transcript already holds: a retry
   * after a respawn (agent spec §3.1.4, §5.2). `StreamProcessor` would append
   * its content to the stored message ("questionquestion"), in main's
   * transcript and in every client replaying the ring, so it is dropped.
   */
  #skipUserEcho(event: RelayEvent): boolean {
    const messageId =
      typeof event.messageId === "string" ? event.messageId : null;
    if (messageId == null) return false;
    if (event.type === "TEXT_MESSAGE_START") {
      if (
        event.role === "user" &&
        this.#processor
          .getMessages()
          .some((message) => message.id === messageId)
      ) {
        this.#skippedUserIds.add(messageId);
        return true;
      }
      return false;
    }
    if (!this.#skippedUserIds.has(messageId)) return false;
    if (event.type === "TEXT_MESSAGE_END")
      this.#skippedUserIds.delete(messageId);
    return event.type.startsWith("TEXT_MESSAGE_");
  }

  #synthesizeTerminal(code: string, message: string): RelayChunk | null {
    const active = this.#active;
    if (active == null) return null;
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

  /** Sequences, applies and fans out one event. */
  #apply(event: RelayEvent): RelayChunk {
    const chunk: RelayChunk = {
      seq: this.#clock.next(),
      event: event as unknown as StreamChunk,
    };

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
      };
    }

    try {
      this.#processor.processChunk(chunk.event);
    } catch (error) {
      this.#log(
        `${this.threadId}: the transcript processor rejected ${event.type}: ${String(error)}`
      );
    }
    this.#applySessionState(event, chunk.seq);
    this.#record(chunk, event);
    if (isTerminal(event)) this.#finishRun(event);

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
    if (
      active.log.length >= ACTIVE_LOG_CAP &&
      event.type === "CUSTOM" &&
      event.name === "tool.output"
    ) {
      // Past the cap only live tool output coalesces, to the latest per call.
      const toolCallId = record(event.value).toolCallId;
      const subagentRunId = event.subagentRunId;
      const index = active.log.findIndex(
        (entry) =>
          (entry.event as { type: string }).type === "CUSTOM" &&
          (entry.event as { name?: string }).name === "tool.output" &&
          record((entry.event as { value?: unknown }).value).toolCallId ===
            toolCallId &&
          (entry.event as { subagentRunId?: unknown }).subagentRunId ===
            subagentRunId
      );
      if (index !== -1) active.log.splice(index, 1);
    }
    active.log.push(chunk);
  }

  #finishRun(event: RelayEvent): void {
    const active = this.#active;
    if (active == null) return;
    this.#active = null;

    this.#finished.set(active.runId, active.log);
    while (this.#finished.size > FINISHED_LOGS_KEPT)
      this.#finished.delete(this.#finished.keys().next().value!);

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
    } catch (error) {
      this.#log(
        `${this.threadId}: persisting the transcript failed: ${String(error)}`
      );
    }
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
        this.clearHistory();
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
