/**
 * A fake main relay (spec 02 §11.1, §13 "main relay fake"): an `AguiSource`
 * over an in-memory event log, answering exactly the contract the kit binds
 * to (§14): seq-numbered events, `hydrate` with the completed transcript (a
 * real `StreamProcessor` over the events before the active run), the
 * session-scoped snapshot and the run outcomes; `joinRun` from the run's
 * `RUN_STARTED`; `subscribe` after a resume point with `abacus.subscribed`
 * first and `abacus.resync` for a point outside the log; `send` idempotent
 * by run id.
 *
 * `relay.ai` is the typed `ai.*` client over the contract's procedures:
 * in process (`createRouterClient` over `fixtureAiRouter`, main's router
 * restated) by default, or whatever `connect` returns, such as main's own
 * router behind a memory transport (`test-support/chat-relay.ts`). The real
 * `ThreadSession` runs on top of it, so fixtures, the gallery and tests
 * exercise the production path.
 *
 * The snapshot is folded here from the log the way main's `ThreadRelay`
 * folds it, independently of the kit's own reducer (`store/apply.ts`), so a
 * test comparing the kit's store with a snapshot compares two
 * implementations (review 02 impl Claude #47).
 */
import { ORPCError, createRouterClient } from "@orpc/server";
import {
  StreamProcessor,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { restoreInboundChunk } from "@tanstack/ai/client";

import type { AiClient } from "#next/data/ai";
import { AgentStatus, type QueueEntry } from "#shared/agent-types";
import type {
  AiHydration,
  AiSendAck,
  AiSendInput,
  AgentState,
  PermissionDescriptor,
} from "#shared/contract";
import type { AiNotice, RunOutcomeRecord } from "#shared/contract/ai-thread";

import {
  fixtureAiRouter,
  type AguiSourceLike,
  type SequencedChunk,
} from "./ai-router";

export interface RelayEvent {
  seq: number;
  event: StreamChunk;
}

type SendHandler = (
  input: AiSendInput,
  relay: FakeRelay
) => AiSendAck | Promise<AiSendAck>;

export interface FakeRelayOptions {
  threadId?: string;
  /** Events already in the log (their seqs are kept). */
  events?: readonly RelayEvent[];
  /** Messages before the first event (a migrated transcript). */
  history?: readonly UIMessage[];
  epoch?: string;
  onSend?: SendHandler;
  onCancel?: (input: { runId?: string }, relay: FakeRelay) => void;
  onRespond?: (
    input: { lineage: unknown; decision: unknown },
    relay: FakeRelay
  ) => void;
  onQueue?: (
    command: "enqueue" | "update" | "remove" | "clear" | "dequeue",
    input: Record<string, unknown>,
    relay: FakeRelay
  ) => void;
  /** Ring floor: resume points below it answer `abacus.resync`. */
  floor?: number;
  /**
   * The `ai.*` client over this relay's source. Default: the contract's
   * procedures called in process.
   */
  connect?: (source: AguiSourceLike) => AiClient;
}

type Listener = (item: RelayEvent) => void;

const control = (
  name: "abacus.subscribed" | "abacus.resync",
  epoch: string
): SequencedChunk => ({
  seq: null,
  event: {
    type: "CUSTOM",
    name,
    value: { epoch },
    timestamp: Date.now(),
  } as StreamChunk,
});

/** The log never leaks: every consumer gets its own copy. */
const deliver = (item: RelayEvent): SequencedChunk => ({
  seq: item.seq,
  event: structuredClone(item.event),
});

/** Counts calls and open iterators, for leak and ordering assertions. */
export interface RelayStats {
  hydrate: number;
  subscribe: number;
  joinRun: number;
  send: AiSendInput[];
  cancel: Array<{ runId?: string }>;
  respond: Array<{ lineage: unknown; decision: unknown }>;
  queue: Array<{ command: string; input: Record<string, unknown> }>;
  openIterators: number;
}

// ─── the snapshot fold (main's ThreadRelay, restated) ───────────────────

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value != null && typeof value === "object" ? (value as Json) : {};

const isTerminalEvent = (event: StreamChunk): boolean =>
  event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";

/** The run a terminal closes (`RUN_ERROR` carries it in `metadata.tanstack`). */
const runOfTerminal = (event: StreamChunk): string | null => {
  const value = record(event);
  if (typeof value.runId === "string") return value.runId;
  const runId = record(record(value.metadata).tanstack).runId;
  return typeof runId === "string" ? runId : null;
};

const customOf = (event: StreamChunk): { name: string; value: Json } | null =>
  event.type === "CUSTOM"
    ? {
        name: String((event as { name?: unknown }).name),
        value: record((event as { value?: unknown }).value),
      }
    : null;

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** RFC 6902 `add`/`replace`/`remove` on members, `-` append; null otherwise. */
const patch = (document: unknown, ops: unknown): unknown => {
  if (!Array.isArray(ops)) return null;
  let root: unknown = structuredClone(document);
  for (const raw of ops) {
    const op = record(raw);
    if (op.op !== "add" && op.op !== "replace" && op.op !== "remove")
      return null;
    if (typeof op.path !== "string") return null;
    if (op.path === "") {
      if (op.op === "remove") return null;
      root = structuredClone(op.value);
      continue;
    }
    if (!op.path.startsWith("/")) return null;
    const tokens = op.path
      .slice(1)
      .split("/")
      .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (tokens.some((token) => UNSAFE.has(token))) return null;
    const last = tokens.pop()!;
    let parent: unknown = root;
    for (const token of tokens) parent = record(parent)[token];
    if (parent == null || typeof parent !== "object") return null;
    if (Array.isArray(parent)) {
      const index = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(index) || index < 0 || index > parent.length)
        return null;
      if (op.op === "add") parent.splice(index, 0, structuredClone(op.value));
      else if (index >= parent.length) return null;
      else if (op.op === "replace") parent[index] = structuredClone(op.value);
      else parent.splice(index, 1);
      continue;
    }
    const members = parent as Json;
    if (op.op === "add") members[last] = structuredClone(op.value);
    else if (!Object.hasOwn(members, last)) return null;
    else if (op.op === "replace") members[last] = structuredClone(op.value);
    else delete members[last];
  }
  return root;
};

interface Folded {
  messages: UIMessage[];
  incarnation: string | null;
  permissions: PermissionDescriptor[];
  queue: QueueEntry[];
  agent: AgentState | null;
  skills: AiHydration["abacus"]["skills"];
  activity: AiHydration["abacus"]["activity"];
  notices: AiNotice[];
  outcomes: RunOutcomeRecord[];
}

/**
 * The transcript as of the last terminal and the session-scoped state, as
 * main's `ThreadRelay` keeps them: every event is folded into the session
 * slices; message content only for completed runs (the active one is
 * rebuilt from replay, §3.3); one outcome per terminal whose steps are the
 * run's parent `TOOL_CALL_START`s and whose `afterMessageId` is the
 * transcript's last message then.
 */
const fold = (
  log: readonly RelayEvent[],
  history: readonly UIMessage[],
  activeStart: number | null
): Folded => {
  let processor = new StreamProcessor({
    initialMessages: structuredClone([...history]),
  });
  let incarnation: string | null = null;
  let pending: { incarnation: string | null; items: PermissionDescriptor[] } = {
    incarnation: null,
    items: [],
  };
  let queue: QueueEntry[] = [];
  let agent: AgentState | null = null;
  let skills: Folded["skills"] = [];
  let activity: Folded["activity"] = {
    status: AgentStatus.Idle,
    runningTools: 0,
  };
  let notices: AiNotice[] = [];
  let outcomes: RunOutcomeRecord[] = [];
  let run: { runId: string; startedAt: number; steps: number } | null = null;

  const setIncarnation = (next: string): void => {
    if (incarnation === next) return;
    incarnation = next;
    if (pending.incarnation !== next)
      pending = { incarnation: next, items: [] };
    queue = [];
  };

  for (const { seq, event } of log) {
    const timestamp = (event as { timestamp?: unknown }).timestamp;
    const at = typeof timestamp === "number" ? timestamp : Date.now();
    const custom = customOf(event);

    if (event.type === "STATE_SNAPSHOT") {
      const snapshot = record((event as { snapshot?: unknown }).snapshot);
      agent = structuredClone(snapshot) as unknown as AgentState;
      if (typeof snapshot.incarnation === "string")
        setIncarnation(snapshot.incarnation);
    } else if (event.type === "STATE_DELTA") {
      if (agent != null)
        agent = patch(
          agent,
          (event as { delta?: unknown }).delta
        ) as AgentState | null;
    } else if (custom != null) {
      const { name, value } = custom;
      if (name === "session.ready" && typeof value.incarnation === "string")
        setIncarnation(value.incarnation);
      else if (name === "session.cleared") {
        processor = new StreamProcessor();
        outcomes = [];
        notices = [];
        run = null;
        continue;
      } else if (name === "permission.pending")
        pending = {
          incarnation:
            typeof value.incarnation === "string" ? value.incarnation : null,
          items: Array.isArray(value.items)
            ? (value.items as PermissionDescriptor[])
            : [],
        };
      else if (name === "queue.updated")
        queue = Array.isArray(value.messages)
          ? (value.messages as QueueEntry[])
          : [];
      else if (name === "skills.loaded")
        skills = Array.isArray(value.skills)
          ? (value.skills as Folded["skills"])
          : [];
      else if (name === "agent.status" && typeof value.status === "string")
        activity = { ...activity, status: value.status as AgentStatus };
      else if (
        name === "agent.heartbeat" &&
        typeof value.runningTools === "number"
      )
        activity = { ...activity, runningTools: value.runningTools };
      else if (
        name === "agent.notification" ||
        name === "agent.error" ||
        name === "abacus.notice"
      ) {
        const key =
          typeof value.notificationKey === "string"
            ? value.notificationKey
            : null;
        notices = [
          ...notices.filter(
            (notice) => key == null || notice.value.notificationKey !== key
          ),
          { seq, name, value },
        ];
      }
    }

    if (event.type === "RUN_STARTED")
      run = {
        runId: String((event as { runId?: unknown }).runId),
        startedAt: at,
        steps: 0,
      };
    else if (
      run != null &&
      event.type === "TOOL_CALL_START" &&
      !(
        typeof (event as { subagentRunId?: unknown }).subagentRunId ===
          "string" && (event as { subagentRunId: string }).subagentRunId !== ""
      )
    )
      run.steps += 1;

    if (activeStart != null && seq >= activeStart) continue;
    try {
      processor.processChunk(restoreInboundChunk(structuredClone(event)));
    } catch {
      // As main: a chunk the processor rejects is logged and skipped.
    }
    if (isTerminalEvent(event) && run != null) {
      const messages = processor.getMessages();
      const base = {
        runId: run.runId,
        startedAt: run.startedAt,
        endedAt: at,
        steps: run.steps,
        afterMessageId: messages.at(-1)?.id ?? null,
      };
      const value = record(event);
      if (event.type === "RUN_ERROR") {
        const error = record(record(record(value.metadata).abacus).error);
        outcomes = [
          ...outcomes,
          {
            ...base,
            kind: "error",
            error: {
              ...(error as NonNullable<RunOutcomeRecord["error"]>),
              ...(typeof value.message === "string"
                ? { message: value.message }
                : {}),
              ...(typeof value.code === "string" ? { code: value.code } : {}),
            },
          },
        ];
      } else {
        const usage = Array.isArray(value.usage) ? value.usage[0] : undefined;
        outcomes = [
          ...outcomes,
          {
            ...base,
            kind:
              record(value.outcome).type === "cancelled"
                ? "cancelled"
                : "success",
            ...(usage != null && typeof usage === "object"
              ? { usage: usage as RunOutcomeRecord["usage"] }
              : {}),
          },
        ];
      }
      run = null;
    }
  }

  return {
    messages: processor.getMessages(),
    incarnation,
    // Dead incarnations are dropped (agent spec §5.3 item 6).
    permissions: pending.items.filter(
      (item) =>
        incarnation == null ||
        item.metadata.abacus.lineage.incarnation === incarnation
    ),
    queue: queue.filter((entry) => entry.hidden !== true),
    agent,
    skills,
    activity,
    notices,
    outcomes,
  };
};

// ─── the relay ─────────────────────────────────────────────────────────

export class FakeRelay {
  readonly threadId: string;
  readonly epoch: string;
  readonly log: RelayEvent[] = [];
  readonly stats: RelayStats = {
    hydrate: 0,
    subscribe: 0,
    joinRun: 0,
    send: [],
    cancel: [],
    respond: [],
    queue: [],
    openIterators: 0,
  };
  floor: number;
  /** Test knobs: make the next calls fail or stall. */
  faults: {
    hydrate?: (call: number) => Error | null | Promise<void>;
    subscribe?: (call: number) => Error | null;
    joinRun?: (
      call: number,
      delivered: number
    ) => Error | "end" | "stall" | null;
    /** Thrown after main recorded the ack: the response is lost. */
    send?: (call: number) => Error | null;
    /** Thrown before main records anything: the prompt never arrived. */
    sendLost?: (call: number) => Error | null;
  } = {};
  history: UIMessage[];
  #listeners = new Set<Listener>();
  #drops = new Set<(error: Error) => void>();
  #acks = new Map<string, AiSendAck>();
  #options: FakeRelayOptions;
  #seq = 0;

  constructor(options: FakeRelayOptions = {}) {
    this.threadId = options.threadId ?? "t-1";
    this.epoch = options.epoch ?? "epoch-1";
    this.history = [...(options.history ?? [])];
    this.#options = options;
    this.floor = options.floor ?? 0;
    for (const item of options.events ?? []) this.#append(item.seq, item.event);
    this.ai =
      options.connect?.(this.source) ??
      createRouterClient(fixtureAiRouter, {
        context: { deps: { ai: this.source } },
      });
  }

  get lastSeq(): number {
    return this.#seq;
  }

  /** Put an event on the stream with the next seq. */
  emit(event: StreamChunk): number {
    const seq = this.#seq + 1;
    this.#append(seq, event);
    return seq;
  }

  emitAll(events: readonly StreamChunk[]): void {
    for (const event of events) this.emit(event);
  }

  #append(seq: number, event: StreamChunk): void {
    this.#seq = Math.max(this.#seq, seq);
    const item = { seq, event };
    this.log.push(item);
    for (const listener of this.#listeners) listener(item);
  }

  /** Open live iterators throw (a port blip); the pump reconnects. */
  dropSubscriptions(error = new Error("chat: connection lost")): void {
    for (const drop of Array.from(this.#drops)) drop(error);
  }

  /** Main restarted: a new relay lifetime. */
  setEpoch(epoch: string): void {
    (this as { epoch: string }).epoch = epoch;
  }

  /** The run in flight: a `RUN_STARTED` with no terminal after it. */
  activeRun(): { runId: string; startSeq: number } | null {
    let active: { runId: string; startSeq: number } | null = null;
    for (const { seq, event } of this.log) {
      if (event.type === "RUN_STARTED")
        active = { runId: (event as { runId: string }).runId, startSeq: seq };
      else if (isTerminalEvent(event)) active = null;
      else if (customOf(event)?.name === "session.cleared") active = null;
    }
    return active;
  }

  #hydrate(): AiHydration {
    const cursor = this.#seq;
    const active = this.activeRun();
    const folded = fold(this.log, this.history, active?.startSeq ?? null);
    const start =
      active == null
        ? undefined
        : this.log.find((item) => item.seq === active.startSeq)?.event;
    const startedAt = (start as { timestamp?: unknown } | undefined)?.timestamp;
    return {
      messages: folded.messages,
      activeRun: active == null ? null : { runId: active.runId },
      interrupts: null,
      abacus: {
        cursor,
        epoch: this.epoch,
        incarnation: folded.incarnation,
        activeRun:
          active == null
            ? null
            : {
                runId: active.runId,
                startSeq: active.startSeq,
                startedAt:
                  typeof startedAt === "number" ? startedAt : Date.now(),
                serverInitiated:
                  record(record(record(start).metadata).abacus)
                    .serverInitiated === true,
              },
        permissions: folded.permissions,
        queue: folded.queue,
        agent: folded.agent,
        skills: folded.skills,
        activity: folded.activity,
        notices: folded.notices,
        runOutcomes: folded.outcomes,
      },
    };
  }

  /**
   * The replay and the live listener are set up in the call's turn (as main
   * does), not when the consumer first pulls, so nothing emitted in between
   * is lost.
   */
  #iterate(
    replay: RelayEvent[],
    first: SequencedChunk | null,
    signal: AbortSignal,
    until: (item: RelayEvent) => boolean,
    live: boolean
  ): AsyncGenerator<SequencedChunk> {
    const queue: RelayEvent[] = [...replay];
    let wake: (() => void) | null = null;
    let dropped: Error | null = null;
    const drop = (error: Error) => {
      dropped = error;
      wake?.();
    };
    const listener: Listener = (item) => {
      queue.push(item);
      wake?.();
    };
    if (live) {
      this.#drops.add(drop);
      this.#listeners.add(listener);
    }
    this.stats.openIterators += 1;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.#drops.delete(drop);
      this.#listeners.delete(listener);
      this.stats.openIterators -= 1;
    };
    const onAbort = () => {
      close();
      wake?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    async function* run(): AsyncGenerator<SequencedChunk> {
      try {
        if (first != null) yield first;
        for (;;) {
          if (dropped != null) throw dropped;
          while (queue.length > 0) {
            if (signal.aborted) return;
            const item = queue.shift()!;
            yield deliver(item);
            if (until(item)) return;
          }
          if (!live || signal.aborted || closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        close();
      }
    }
    return run();
  }

  #queue(
    command: "enqueue" | "update" | "remove" | "clear" | "dequeue",
    input: Record<string, unknown>
  ): void {
    this.stats.queue.push({ command, input });
    this.#options.onQueue?.(command, input, this);
  }

  /** Main's `AguiSource`, over the log. */
  readonly source: AguiSourceLike = {
    hydrate: async () => {
      this.stats.hydrate += 1;
      const snapshot = this.#hydrate();
      const fault = await this.faults.hydrate?.(this.stats.hydrate);
      if (fault instanceof Error) throw fault;
      return snapshot;
    },
    subscribe: (_threadId, afterSeq, signal, epoch) => {
      this.stats.subscribe += 1;
      const fault = this.faults.subscribe?.(this.stats.subscribe);
      if (fault != null) throw fault;
      const after = afterSeq ?? this.floor;
      const outside =
        after < this.floor ||
        after > this.#seq ||
        (epoch != null && epoch !== this.epoch);
      if (outside)
        return this.#iterate(
          [],
          control("abacus.resync", this.epoch),
          signal,
          () => false,
          true
        );
      return this.#iterate(
        this.log.filter((item) => item.seq > after),
        control("abacus.subscribed", this.epoch),
        signal,
        () => false,
        true
      );
    },
    joinRun: (runId, signal) => {
      this.stats.joinRun += 1;
      const call = this.stats.joinRun;
      const start = this.log.find(
        (item) =>
          item.event.type === "RUN_STARTED" &&
          (item.event as { runId: string }).runId === runId
      );
      if (start == null)
        return this.#iterate([], null, signal, () => true, false);
      let terminal = false;
      const replay = this.log.filter((item) => {
        if (item.seq < start.seq || terminal) return false;
        if (isTerminalEvent(item.event) && runOfTerminal(item.event) === runId)
          terminal = true;
        return true;
      });
      const faults = this.faults.joinRun;
      let delivered = 0;
      const inner = this.#iterate(
        replay,
        null,
        signal,
        (item) =>
          isTerminalEvent(item.event) && runOfTerminal(item.event) === runId,
        !terminal
      );
      async function* guarded(): AsyncGenerator<SequencedChunk> {
        for await (const item of inner) {
          const fault = faults?.(call, delivered);
          if (fault === "end") return;
          if (fault === "stall") {
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                })
              );
            return;
          }
          if (fault != null) throw fault;
          delivered += 1;
          yield item;
        }
      }
      return guarded();
    },
    runFinished: () => {
      throw new ORPCError("UNAVAILABLE", {
        message: "The fixture relay has no run-finished stream",
      });
    },
    attention: () => {
      throw new ORPCError("UNAVAILABLE", {
        message: "The fixture relay has no attention stream",
      });
    },
    send: async (input) => {
      this.stats.send.push(input);
      const lost = this.faults.sendLost?.(this.stats.send.length);
      if (lost != null) throw lost;
      const fault = this.faults.send?.(this.stats.send.length);
      const known = this.#acks.get(input.runId);
      if (known != null) {
        if (fault != null) throw fault;
        return {
          runId: input.runId,
          status: "duplicate",
          ...(known.status !== "duplicate" ? { original: known.status } : {}),
        };
      }
      const ack = (await this.#options.onSend?.(input, this)) ?? {
        runId: input.runId,
        status: "started" as const,
      };
      this.#acks.set(input.runId, ack);
      if (fault != null) throw fault;
      return ack;
    },
    cancel: async (_threadId, runId) => {
      this.stats.cancel.push(runId != null ? { runId } : {});
      this.#options.onCancel?.(runId != null ? { runId } : {}, this);
    },
    respondPermission: async (input) => {
      this.stats.respond.push({
        lineage: input.lineage,
        decision: input.decision,
      });
      this.#options.onRespond?.(input, this);
    },
    queue: {
      enqueue: async (threadId, message) =>
        this.#queue("enqueue", { threadId, message }),
      update: async (input) => this.#queue("update", input),
      remove: async (input) => this.#queue("remove", input),
      clear: async (threadId) => this.#queue("clear", { threadId }),
      dequeue: async (threadId) => this.#queue("dequeue", { threadId }),
    },
  };

  /** The `ai.*` client the kit is given. */
  readonly ai: AiClient;
}
