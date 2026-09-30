/**
 * A fake main relay (spec 02 §11.1, §13 "main relay fake"): the `ai.*`
 * slice of the `AppClient` over an in-memory event log, answering exactly
 * the contract the kit binds to (§14): seq-numbered events with
 * `String(seq)` event ids, `hydrate` with the completed transcript (a real
 * `StreamProcessor` over the events before the active run), the
 * session-scoped snapshot, run outcomes and paging; `joinRun` from the
 * run's `RUN_STARTED`; `subscribe` after `lastEventId` with
 * `abacus.subscribed` first and `abacus.resync` for a point outside the log;
 * `send` idempotent by run id. The real `ThreadSession` runs on top of it,
 * so fixtures, the gallery and tests exercise the production path.
 */
import { ORPCError, withEventMeta } from "@orpc/client";
import { StreamProcessor, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { restoreInboundChunk } from "@tanstack/ai/client";

import type { AiClient } from "#next/data/ai";

import type { AiHydration, AiSendAck, AiSendInput } from "#shared/contract/ai";
import type { AiNotice, RunOutcomeRecord } from "#shared/contract/ai-thread";

import { applyEvent, isTerminal, recordTerminal, terminalRunId } from "../store/apply";
import { emptyThreadState, type ThreadStoreState } from "../store/thread-store";

export interface RelayEvent {
  seq: number;
  event: StreamChunk;
}

export type SendHandler = (
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
  onRespond?: (input: { lineage: unknown; decision: unknown }, relay: FakeRelay) => void;
  onQueue?: (
    command: "enqueue" | "update" | "remove" | "clear" | "dequeue",
    input: Record<string, unknown>,
    relay: FakeRelay
  ) => void;
  /** Ring floor: resume points below it answer `abacus.resync`. */
  floor?: number;
}

type Listener = (item: RelayEvent) => void;

const control = (name: "abacus.subscribed" | "abacus.resync", epoch: string): StreamChunk =>
  ({ type: "CUSTOM", name, value: { epoch }, timestamp: Date.now() }) as unknown as StreamChunk;

const deliver = (item: RelayEvent): StreamChunk =>
  withEventMeta(structuredClone(item.event) as object, {
    id: String(item.seq),
  }) as StreamChunk;

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
    send?: (call: number) => Error | null;
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
    for (const drop of [...this.#drops]) drop(error);
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
      else if (isTerminal(event)) active = null;
      else if (
        event.type === "CUSTOM" &&
        (event as { name?: string }).name === "session.cleared"
      )
        active = null;
    }
    return active;
  }

  /** The transcript, session state and outcomes as of `upTo` (main's checkpoint). */
  #fold(upTo: number): {
    messages: UIMessage[];
    state: ThreadStoreState;
    outcomes: RunOutcomeRecord[];
    notices: AiNotice[];
  } {
    const active = this.activeRun();
    let processor = new StreamProcessor({
      initialMessages: structuredClone(this.history),
    });
    let state = emptyThreadState(-1);
    let notices: AiNotice[] = [];
    for (const { seq, event } of this.log) {
      if (seq > upTo) break;
      if (
        event.type === "CUSTOM" &&
        (event as { name?: string }).name === "session.cleared"
      ) {
        processor = new StreamProcessor();
        state = { ...emptyThreadState(-1), agent: state.agent, incarnation: state.incarnation, skills: state.skills };
        notices = [];
        continue;
      }
      const name = event.type === "CUSTOM" ? (event as { name: string }).name : null;
      if (name === "agent.notification" || name === "agent.error") {
        const value = (event as { value: Record<string, unknown> }).value;
        const key = typeof value.notificationKey === "string" ? value.notificationKey : null;
        notices = [
          ...notices.filter((notice) => key == null || notice.value.notificationKey !== key),
          { seq, name, value },
        ];
      }
      state = applyEvent(state, seq, event);
      if (active != null && seq >= active.startSeq) continue;
      try {
        processor.processChunk(restoreInboundChunk(structuredClone(event)));
      } catch {
        // As main: a chunk the processor rejects is logged and skipped.
      }
      if (isTerminal(event))
        state = recordTerminal(state, event, processor.getMessages(), seq);
    }
    return {
      messages: processor.getMessages(),
      state,
      outcomes: state.runs.outcomes,
      notices,
    };
  }

  #hydrate(input: { limit?: number; before?: string }): AiHydration {
    const cursor = this.#seq;
    const active = this.activeRun();
    const { messages, state, outcomes, notices } = this.#fold(cursor);
    let end = messages.length;
    if (input.before != null) {
      end = messages.findIndex((message) => message.id === input.before);
      if (end === -1)
        throw new ORPCError("NOT_FOUND", {
          data: { entity: "thread", id: this.threadId },
        });
    }
    const limit = input.limit ?? messages.length;
    const start = Math.max(0, end - limit);
    const window = messages.slice(start, end);
    const ids = new Set(window.map((message) => message.id));
    const newest = end === messages.length;
    const activeStart = active == null ? null : this.log.find((item) => item.seq === active.startSeq);
    return {
      messages: window,
      activeRun: active == null ? null : { runId: active.runId },
      interrupts: null,
      page:
        start > 0
          ? { truncated: true, cursor: window[0]!.id }
          : { truncated: false },
      abacus: {
        cursor,
        epoch: this.epoch,
        incarnation: state.incarnation,
        activeRun:
          active == null
            ? null
            : {
                runId: active.runId,
                startSeq: active.startSeq,
                startedAt:
                  (activeStart?.event as { timestamp?: number } | undefined)?.timestamp ?? Date.now(),
                serverInitiated:
                  (activeStart?.event as { metadata?: { abacus?: { serverInitiated?: boolean } } } | undefined)
                    ?.metadata?.abacus?.serverInitiated === true,
              },
        permissions: state.permissions.items,
        queue: state.queue,
        agent: state.agent,
        skills: state.skills,
        activity: {
          status: state.activity.status ?? ("idle" as never),
          runningTools: state.activity.runningTools,
        },
        notices,
        runOutcomes: outcomes.filter(
          (outcome) =>
            (outcome.afterMessageId != null && ids.has(outcome.afterMessageId)) ||
            (outcome.afterMessageId == null && newest)
        ),
      },
    };
  }

  async *#iterate(
    replay: RelayEvent[],
    first: StreamChunk | null,
    signal: AbortSignal | undefined,
    until: (item: RelayEvent) => boolean,
    live: boolean
  ): AsyncGenerator<StreamChunk> {
    const queue: RelayEvent[] = [...replay];
    let wake: (() => void) | null = null;
    let dropped: Error | null = null;
    const drop = (error: Error) => {
      dropped = error;
      wake?.();
    };
    if (live) this.#drops.add(drop);
    const listener: Listener = (item) => {
      queue.push(item);
      wake?.();
    };
    if (live) this.#listeners.add(listener);
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort);
    this.stats.openIterators += 1;
    try {
      if (first != null) yield first;
      for (;;) {
        if (dropped != null) throw dropped;
        while (queue.length > 0) {
          if (signal?.aborted === true) return;
          const item = queue.shift()!;
          yield deliver(item);
          if (until(item)) return;
        }
        if (!live || signal?.aborted === true) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      this.#drops.delete(drop);
      this.#listeners.delete(listener);
      signal?.removeEventListener("abort", onAbort);
      this.stats.openIterators -= 1;
    }
  }

  /** The `ai.*` client slice. Typed loosely: oRPC's client options are unused. */
  readonly ai: AiClient = {
    hydrate: async (input: { threadId: string; limit?: number; before?: string }) => {
      this.stats.hydrate += 1;
      const fault = await this.faults.hydrate?.(this.stats.hydrate);
      if (fault instanceof Error) throw fault;
      return this.#hydrate(input);
    },
    subscribe: async (
      input: { threadId: string; lastEventId?: string; epoch?: string },
      options?: { signal?: AbortSignal }
    ) => {
      this.stats.subscribe += 1;
      const fault = this.faults.subscribe?.(this.stats.subscribe);
      if (fault != null) throw fault;
      const after = input.lastEventId == null ? this.#seq : Number(input.lastEventId);
      const outside =
        !Number.isSafeInteger(after) ||
        after < this.floor ||
        after > this.#seq ||
        (input.epoch != null && input.epoch !== this.epoch);
      if (outside)
        return this.#iterate([], control("abacus.resync", this.epoch), options?.signal, () => false, true);
      return this.#iterate(
        this.log.filter((item) => item.seq > after),
        control("abacus.subscribed", this.epoch),
        options?.signal,
        () => false,
        true
      );
    },
    joinRun: async (input: { runId: string }, options?: { signal?: AbortSignal }) => {
      this.stats.joinRun += 1;
      const call = this.stats.joinRun;
      const start = this.log.find(
        (item) => item.event.type === "RUN_STARTED" && (item.event as { runId: string }).runId === input.runId
      );
      if (start == null) return this.#iterate([], null, options?.signal, () => true, false);
      let terminal = false;
      const replay = this.log.filter((item) => {
        if (item.seq < start.seq || terminal) return false;
        if (isTerminal(item.event) && terminalRunId(item.event) === input.runId) terminal = true;
        return true;
      });
      const faults = this.faults.joinRun;
      let delivered = 0;
      const inner = this.#iterate(
        replay,
        null,
        options?.signal,
        (item) => isTerminal(item.event) && terminalRunId(item.event) === input.runId,
        !terminal
      );
      const signal = options?.signal;
      async function* guarded(): AsyncGenerator<StreamChunk> {
        for await (const event of inner) {
          const fault = faults?.(call, delivered);
          if (fault === "end") return;
          if (fault === "stall") {
            await new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true })
            );
            return;
          }
          if (fault != null) throw fault;
          delivered += 1;
          yield event;
        }
      }
      return guarded();
    },
    send: async (input: AiSendInput) => {
      this.stats.send.push(input);
      const fault = this.faults.send?.(this.stats.send.length);
      const known = this.#acks.get(input.runId);
      if (known != null) {
        if (fault != null) throw fault;
        return { runId: input.runId, status: "duplicate", original: known.status as never };
      }
      const ack = (await this.#options.onSend?.(input, this)) ?? {
        runId: input.runId,
        status: "started" as const,
      };
      this.#acks.set(input.runId, ack);
      if (fault != null) throw fault;
      return ack;
    },
    cancel: async (input: { threadId: string; runId?: string }) => {
      this.stats.cancel.push({ ...(input.runId != null ? { runId: input.runId } : {}) });
      this.#options.onCancel?.(input, this);
    },
    respondPermission: async (input: { lineage: unknown; decision: unknown }) => {
      this.stats.respond.push({ lineage: input.lineage, decision: input.decision });
      this.#options.onRespond?.(input, this);
    },
    queue: {
      enqueue: async (input: Record<string, unknown>) => this.#queue("enqueue", input),
      update: async (input: Record<string, unknown>) => this.#queue("update", input),
      remove: async (input: Record<string, unknown>) => this.#queue("remove", input),
      clear: async (input: Record<string, unknown>) => this.#queue("clear", input),
      dequeue: async (input: Record<string, unknown>) => this.#queue("dequeue", input),
    },
  } as unknown as AiClient;

  #queue(
    command: "enqueue" | "update" | "remove" | "clear" | "dequeue",
    input: Record<string, unknown>
  ): void {
    this.stats.queue.push({ command, input });
    this.#options.onQueue?.(command, input, this);
  }
}
