/**
 * `ThreadSession` (spec 02 §3.1-§3.3): one per thread per document. It owns
 * the generations (each: a hydrate snapshot, a fresh receive-only
 * `ChatClient`, a thread store, a dispatcher and a pump), the readiness
 * promise loaders await, recovery, the host store React reads, and the
 * admission outbox. `ChatClient` is never asked to start a request.
 */
import type { StreamChunk } from "@tanstack/ai";
import {
  ChatClient,
  type ChatClientState,
  type QueueStrategy,
  type SubagentHandle,
  type UIMessage,
} from "@tanstack/ai-client";
import { Store } from "@tanstack/react-store";

import { isNotFound, type AiClient } from "#renderer/data/ai";
import type { PermissionDecision } from "@abacus-ai/contract/agent-types";
import type { AiHydration } from "@abacus-ai/contract/contract/ai";

import { isAllowed } from "../kit/permissions/decisions";
import {
  applyEvent,
  customName,
  isTerminal,
  recordTerminal,
} from "../store/apply";
import {
  createThreadStore,
  emptyThreadState,
  stateFromSnapshot,
  type PermissionDescriptor,
  type RunOutcomeRecord,
  type ThreadStoreState,
} from "../store/thread-store";
import {
  RECONCILE_DELAYS_MS,
  discardEntry,
  retryEntry,
  submit as submitAdmission,
  admitEnvelope,
  type SubmissionEnvelope,
  type AdmissionHost,
  type AdmissionResult,
  type OutboxEntry,
} from "./admission";
import { deferred, type Deferred } from "./deferred";
import { createDispatcher, type Dispatcher } from "./dispatcher";
import { runPump, type ConnectionState } from "./pump";

const PAGE_SIZE = 50;
/** Processor retention (§10). */
const MAX_MESSAGES = 300;
const READY_CAP_MS = 5000;
const PERMISSION_TIMEOUT_MS = 10_000;
const QUEUE_COMMAND_TIMEOUT_MS = 10_000;

export class ThreadRetiredError extends Error {
  constructor(threadId: string) {
    super(`chat: thread ${threadId} was retired`);
    this.name = "ThreadRetiredError";
  }
}

class ChatBusyError extends Error {
  constructor(reason: string) {
    super(`chat.send-while-busy (${reason})`);
    this.name = "ChatBusyError";
  }
}

/** F1: a request path through the client is a bug; it rejects loudly. */
const throwWhenBusy: QueueStrategy = ({ busyReason }) => {
  throw new ChatBusyError(String(busyReason));
};

export interface HostState {
  gen: number;
  rev: number;
  store: Store<ThreadStoreState>;
  client: ChatClient | null;
  messages: UIMessage[];
  subagents: SubagentHandle[];
  status: ChatClientState;
  sessionGenerating: boolean;
  outbox: OutboxEntry[];
  connection: ConnectionState;
  hasOlderMessages: boolean;
  olderCursor: string | null;
  older: "idle" | "loading" | "error";
  ready: boolean;
  /** Readiness came from the 5 s cap, not from reaching the checkpoint. */
  partial: boolean;
  phase: "idle" | "loading" | "ready" | "error";
  error: unknown;
  notFound: boolean;
  cancelling: boolean;
}

type GenerationFields = Pick<
  HostState,
  "messages" | "subagents" | "status" | "sessionGenerating"
>;

interface Generation {
  readonly g: number;
  readonly abort: AbortController;
  readonly ready: Deferred<void>;
  positions: { checkpoint: number; receivedSeq: number; epoch: string | null };
  appliedSeq: number;
  client: ChatClient | null;
  store: Store<ThreadStoreState> | null;
  dispatcher: Dispatcher | null;
  staged: GenerationFields;
  paging: Pick<HostState, "hasOlderMessages" | "olderCursor">;
  swapped: boolean;
  failed: boolean;
  capTimer: ReturnType<typeof setTimeout> | null;
  activeStart: number;
}

export interface ThreadSessionOptions {
  ai: AiClient;
  threadId: string;
  /** §3.3 recovery back-off (tests shorten it); past the last, `error`. */
  recoveryDelaysMs?: readonly number[];
  reconcileDelaysMs?: readonly number[];
  pumpRetryDelaysMs?: readonly number[];
  readyCapMs?: number;
  newId?: (prefix: "u" | "run") => string;
  /** Test seam: wraps the constructed client (the ordering property test). */
  onClient?: (client: ChatClient, g: number) => void;
  onConsumed?: (seq: number, g: number) => void;
  log?: (message: string, error?: unknown) => void;
}

const RECOVERY_DELAYS_MS = [0, 250, 1000, 4000] as const;

const initialHost = (): HostState => ({
  gen: 0,
  rev: 0,
  store: createThreadStore(emptyThreadState()),
  client: null,
  messages: [],
  subagents: [],
  status: "ready",
  sessionGenerating: false,
  outbox: [],
  connection: "connecting",
  hasOlderMessages: false,
  olderCursor: null,
  older: "idle",
  ready: false,
  partial: false,
  phase: "idle",
  error: null,
  notFound: false,
  cancelling: false,
});

const genBoundary = (start: number, total: number): number =>
  Math.max(0, Math.min(start, total));

const uuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class ThreadSession {
  readonly threadId: string;
  readonly hostStore = new Store<HostState>(initialHost());
  readonly #ai: AiClient;
  readonly #options: ThreadSessionOptions;
  #gen = 0;
  #rev = 0;
  #live: Generation | null = null;
  #pending: Generation | null = null;
  #retired = false;
  #recoveries = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #pins = 0;
  #loadWaiters = 0;
  #cancelAttempt = 0;
  #permissionAttempt = 0;
  #cancelTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #admission: AdmissionHost;
  /** Message ids confirmed by `abacus.duplicate_echo` (§14.12). */
  readonly #prependListeners = new Set<() => void>();
  onPrepend(listener: () => void): () => void {
    this.#prependListeners.add(listener);
    return () => {
      this.#prependListeners.delete(listener);
    };
  }
  readonly #echoed = new Set<string>();

  constructor(options: ThreadSessionOptions) {
    this.threadId = options.threadId;
    this.#ai = options.ai;
    this.#options = options;
    this.#admission = this.#createAdmission();
  }

  // ─── public surface ────────────────────────────────────────────────

  get gen(): number {
    return this.#gen;
  }

  get rev(): number {
    return this.#rev;
  }

  get ready(): boolean {
    return this.hostStore.state.ready;
  }

  get retired(): boolean {
    return this.#retired;
  }

  /** The store of the generation on screen. */
  get store(): Store<ThreadStoreState> {
    return this.hostStore.state.store;
  }

  /** The generation in construction or on screen, for tests and devtools. */
  positions(): {
    gen: number;
    checkpoint: number;
    receivedSeq: number;
    appliedSeq: number;
    reconstructed: boolean;
  } | null {
    const gen = this.#pending ?? this.#live;
    if (gen == null) return null;
    return {
      gen: gen.g,
      checkpoint: gen.positions.checkpoint,
      receivedSeq: gen.positions.receivedSeq,
      appliedSeq: gen.appliedSeq,
      reconstructed: gen.appliedSeq >= gen.positions.checkpoint,
    };
  }

  get pinned(): boolean {
    return this.#pins > 0;
  }

  pin(): () => void {
    this.#pins += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#pins -= 1;
    };
  }

  /** The current generation's readiness; one promise for every caller (§3.2). */
  load(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#retired)
      return Promise.reject(new ThreadRetiredError(this.threadId));
    if (options.signal?.aborted)
      return Promise.reject(new DOMException("Load aborted", "AbortError"));
    const current = this.#pending ?? this.#live;
    const gen = current == null || current.failed ? this.#start() : current;
    this.#loadWaiters += 1;
    if (!options.signal) {
      const finished = () => {
        this.#loadWaiters -= 1;
      };
      gen.ready.promise.then(finished, finished);
      return gen.ready.promise;
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return;
        settled = true;
        this.#loadWaiters -= 1;
        options.signal?.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => {
        done(new DOMException("Load aborted", "AbortError"));
        if (
          this.#loadWaiters === 0 &&
          !this.pinned &&
          !this.hostStore.state.ready
        )
          this.retire();
      };
      options.signal?.addEventListener("abort", aborted, { once: true });
      gen.ready.promise.then(
        () => done(),
        (error) => done(error)
      );
    });
  }

  /** The connection error's Retry, and a `NOT_FOUND` row that came back. */
  reconnect(): Promise<void> {
    this.#recoveries = 0;
    return this.#start().ready.promise;
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#rev += 1;
    this.#echoed.clear();
    this.#prependListeners.clear();
    this.#host({ rev: this.#rev, outbox: [] });
    const error = new ThreadRetiredError(this.threadId);
    for (const gen of [this.#pending, this.#live]) {
      if (gen == null) continue;
      gen.ready.reject(error);
      // Nobody may be waiting; never an unhandled rejection.
      gen.ready.promise.catch(() => {});
      this.#teardown(gen);
    }
    this.#pending = null;
    this.#live = null;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  /** §3.7: `ai.send` with an outbox entry; the composer reads the result. */
  submit(
    text: string,
    forwardedProps?: Record<string, unknown>
  ): Promise<AdmissionResult> {
    return submitAdmission(this.#admission, text, forwardedProps).result;
  }

  async admitEnvelope(envelope: SubmissionEnvelope): Promise<AdmissionResult> {
    await this.load();
    return admitEnvelope(this.#admission, envelope);
  }

  retryOutbox(entryId: string): Promise<AdmissionResult> {
    return retryEntry(this.#admission, entryId);
  }

  discardOutbox(entryId: string): OutboxEntry | undefined {
    return discardEntry(this.#admission, entryId);
  }

  /**
   * Retry after a failed or cancelled run (§3.7): a new run id with the last
   * user message's id and text.
   */
  async retry(
    forwardedProps?: Record<string, unknown>,
    fallbackMessage?: string
  ): Promise<AdmissionResult> {
    const messages = this.hostStore.state.messages;
    const last = messages.findLast((message) => message.role === "user");
    if (last == null) {
      if (!fallbackMessage) return { kind: "rejected", reason: "empty" };
      return submitAdmission(this.#admission, fallbackMessage, forwardedProps)
        .result;
    }
    const text = last.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { content: string }).content)
      .join("");
    if (this.hostStore.state.outbox.length > 0)
      return { kind: "rejected", reason: "busy" };
    return submitAdmission(this.#admission, text, forwardedProps, last.id)
      .result;
  }

  /** The Stop target (§4.5): the active run, else the newest admission. */
  stopTarget(): string | undefined {
    return (
      this.store.state.runs.active?.runId ??
      this.hostStore.state.outbox.at(-1)?.runId
    );
  }

  async cancel(): Promise<void> {
    if (this.hostStore.state.cancelling) return;
    const runId = this.stopTarget();
    const attempt = ++this.#cancelAttempt;
    const rev = this.#rev;
    const gen = this.#gen;
    const clear = (): void => {
      if (
        !this.#retired &&
        gen === this.#gen &&
        rev === this.#rev &&
        attempt === this.#cancelAttempt &&
        this.stopTarget() === runId
      )
        this.#host({ cancelling: false });
    };
    this.#host({ cancelling: true });
    if (this.#cancelTimer != null) {
      clearTimeout(this.#cancelTimer);
      this.#timers.delete(this.#cancelTimer);
    }
    this.#cancelTimer = this.#after(15_000, clear);
    try {
      await this.#ai.cancel({
        threadId: this.threadId,
        ...(runId != null ? { runId } : {}),
      });
    } catch (error) {
      clear();
      throw error;
    }
  }

  // ─── permissions (§6.3) ────────────────────────────────────────────

  async respondPermission(
    descriptor: PermissionDescriptor,
    decision: PermissionDecision
  ): Promise<void> {
    if (this.#retired) return;
    if (!isAllowed(descriptor, decision))
      throw new Error("chat: decision is not allowed");
    const gen = this.#gen;
    const rev = this.#rev;
    const since = ++this.#permissionAttempt;
    const store = this.store;
    const id = descriptor.id;
    const decisionName =
      typeof decision === "string" ? decision : decision.type;
    store.setState((state) => ({
      ...state,
      permissions: {
        ...state.permissions,
        answering: {
          ...state.permissions.answering,
          [id]: { state: "sending", decision: decisionName, since },
        },
      },
    }));
    const noResponse = (): void =>
      store.setState((state) => {
        const current = state.permissions.answering[id];
        if (
          this.#retired ||
          gen !== this.#gen ||
          rev !== this.#rev ||
          store !== this.store ||
          current?.state !== "sending" ||
          current.since !== since
        )
          return state;
        return {
          ...state,
          permissions: {
            ...state.permissions,
            answering: {
              ...state.permissions.answering,
              [id]: {
                state: "error",
                message: "noResponse",
                since: Date.now(),
              },
            },
          },
        };
      });
    const timer = this.#after(PERMISSION_TIMEOUT_MS, noResponse);
    try {
      await this.#ai.respondPermission({
        threadId: this.threadId,
        lineage: descriptor.metadata.abacus.lineage,
        decision,
      });
    } catch {
      clearTimeout(timer);
      this.#timers.delete(timer);
      noResponse();
    }
  }

  // ─── queue (§8.5) ─────────────────────────────────────────────────

  async enqueue(text: string): Promise<void> {
    await this.#ai.queue.enqueue({ threadId: this.threadId, message: text });
  }

  async clearQueue(): Promise<void> {
    await this.#ai.queue.clear({ threadId: this.threadId });
  }

  async updateQueued(entryId: string, text: string): Promise<void> {
    await this.#queueCommand(entryId, "update", text);
  }

  async removeQueued(entryId: string): Promise<void> {
    await this.#queueCommand(entryId, "remove");
  }

  clearQueueCommand(entryId: string): void {
    this.store.setState((state) => {
      if (!(entryId in state.queueCommands)) return state;
      const { [entryId]: _gone, ...queueCommands } = state.queueCommands;
      return { ...state, queueCommands };
    });
  }

  async #queueCommand(
    entryId: string,
    command: "update" | "remove",
    text?: string
  ): Promise<void> {
    const store = this.store;
    const incarnation = store.state.incarnation;
    const since = Date.now();
    store.setState((state) => ({
      ...state,
      queueCommands: {
        ...state.queueCommands,
        [entryId]: {
          state: "pending",
          command,
          since,
          ...(text != null ? { text } : {}),
        },
      },
    }));
    const timeout = (): void =>
      store.setState((state) => {
        const current = state.queueCommands[entryId];
        if (current?.state !== "pending" || current.since !== since)
          return state;
        return {
          ...state,
          queueCommands: {
            ...state.queueCommands,
            [entryId]: { ...current, state: "timeout" },
          },
        };
      });
    this.#after(QUEUE_COMMAND_TIMEOUT_MS, timeout);
    if (incarnation == null) {
      timeout();
      return;
    }
    try {
      if (command === "update")
        await this.#ai.queue.update({
          threadId: this.threadId,
          incarnation,
          entryId,
          message: text ?? "",
        });
      else
        await this.#ai.queue.remove({
          threadId: this.threadId,
          incarnation,
          entryId,
        });
    } catch {
      timeout();
    }
  }

  // ─── history paging and retention (§10) ────────────────────────────

  async loadOlder(): Promise<void> {
    const live = this.#live;
    const host = this.hostStore.state;
    const cursor = host.olderCursor;
    if (live == null || cursor == null || host.older === "loading") return;
    const token = { gen: this.#gen, rev: this.#rev, client: live.client };
    const unchanged = (): boolean =>
      token.gen === this.#gen &&
      token.rev === this.#rev &&
      this.#live?.client === token.client;
    for (const listener of this.#prependListeners) listener();
    this.#host({ older: "loading" });
    let page: AiHydration;
    try {
      page = await this.#ai.hydrate({
        threadId: this.threadId,
        limit: PAGE_SIZE,
        before: cursor,
      });
    } catch (error) {
      if (!unchanged()) return;
      if (isNotFound(error)) {
        // The cursor is gone (a clear): stop paging, rebuild (§14.12).
        this.#host({
          older: "idle",
          hasOlderMessages: false,
          olderCursor: null,
        });
        this.#start();
        return;
      }
      this.#host({ older: "error" });
      return;
    }
    // A recovery or a reset happened meanwhile: discard (review r2-7).
    if (!unchanged() || token.client == null) return;
    const existing = token.client.getMessages();
    const ids = new Set(existing.map((message) => message.id));
    const older = page.messages.filter((message) => !ids.has(message.id));
    for (const listener of this.#prependListeners) listener();
    live.activeStart += older.length;
    token.client.setMessagesManually([...older, ...existing]);
    this.#mergeOutcomes(live, page.abacus.runOutcomes);
    this.#host({
      older: "idle",
      hasOlderMessages: page.page?.truncated === true,
      olderCursor: page.page?.truncated === true ? page.page.cursor : null,
      messages: token.client.getMessages(),
    });
  }

  /**
   * Processor retention (§10): past `max`, drop the oldest completed
   * messages (never the active run's) and their outcome records; paging
   * then reaches them again.
   */
  isMessageInActiveRun(id: string): boolean {
    const live = this.#live;
    return (
      live?.store?.state.runs.active != null &&
      this.hostStore.state.messages.findIndex((message) => message.id === id) >=
        live.activeStart
    );
  }

  retain(max = MAX_MESSAGES): void {
    const live = this.#live;
    const client = live?.client;
    if (live == null || client == null || live.store == null) return;
    const messages = client.getMessages();
    if (messages.length <= max) return;
    const active = live.store.state.runs.active;
    const boundary =
      active == null
        ? messages.length
        : genBoundary(live.activeStart, messages.length);
    const count = Math.min(messages.length - max, boundary);
    if (count === 0) return;
    const dropped = messages.slice(0, count);
    const kept = messages.slice(count);
    live.activeStart = Math.max(0, live.activeStart - count);
    const gone = new Set(dropped.map((message) => message.id));
    client.setMessagesManually(kept);
    live.store.setState((state) => ({
      ...state,
      runs: {
        ...state.runs,
        outcomes: state.runs.outcomes.filter(
          (outcome) =>
            outcome.afterMessageId == null || !gone.has(outcome.afterMessageId)
        ),
      },
    }));
    this.#host({
      messages: client.getMessages(),
      hasOlderMessages: true,
      olderCursor: kept[0]?.id ?? this.hostStore.state.olderCursor,
    });
  }

  // ─── generations (§3.3) ────────────────────────────────────────────

  #start(): Generation {
    // A cancellation belongs to the generation that issued it.
    this.#cancelAttempt += 1;
    if (this.#cancelTimer != null) {
      clearTimeout(this.#cancelTimer);
      this.#timers.delete(this.#cancelTimer);
      this.#cancelTimer = null;
    }
    this.#host({ cancelling: false });
    const g = ++this.#gen;
    const gen: Generation = {
      g,
      abort: new AbortController(),
      ready: deferred<void>(),
      positions: { checkpoint: 0, receivedSeq: 0, epoch: null },
      appliedSeq: 0,
      client: null,
      store: null,
      dispatcher: null,
      staged: {
        messages: [],
        subagents: [],
        status: "ready",
        sessionGenerating: false,
      },
      paging: { hasOlderMessages: false, olderCursor: null },
      swapped: false,
      failed: false,
      capTimer: null,
      activeStart: 0,
    };
    // Waiting loaders follow the newest generation (review r3-1).
    const superseded = this.#pending;
    if (superseded != null) {
      superseded.ready.resolve(gen.ready.promise);
      this.#teardown(superseded);
    }
    // The generation on screen stops reading; it renders until the swap.
    this.#live?.abort.abort();
    this.#live?.dispatcher?.close();
    this.#pending = gen;
    gen.capTimer = this.#after(this.#options.readyCapMs ?? READY_CAP_MS, () => {
      if (gen.g !== this.#gen || gen.swapped || this.#retired) return;
      if (gen.client == null)
        this.#fail(gen, new Error("chat: hydration timed out"));
      else this.#swap(gen, true);
    });
    if (!this.hostStore.state.ready) this.#host({ phase: "loading" });
    void this.#build(gen);
    return gen;
  }

  async #build(gen: Generation): Promise<void> {
    let snapshot: AiHydration;
    try {
      snapshot = await this.#ai.hydrate(
        {
          threadId: this.threadId,
          limit: PAGE_SIZE,
        },
        { signal: gen.abort.signal }
      );
    } catch (error) {
      if (
        gen.g !== this.#gen ||
        gen.failed ||
        gen.abort.signal.aborted ||
        this.#retired
      )
        return;
      if (this.hostStore.state.ready && !isNotFound(error)) this.#recover();
      else this.#fail(gen, error);
      return;
    }
    if (
      gen.g !== this.#gen ||
      gen.failed ||
      gen.abort.signal.aborted ||
      this.#retired
    )
      return;
    const abacus = snapshot.abacus;
    const active = abacus.activeRun;
    gen.activeStart = snapshot.messages.length;
    gen.positions = {
      checkpoint: abacus.cursor,
      receivedSeq: active != null ? active.startSeq - 1 : abacus.cursor,
      epoch: abacus.epoch ?? null,
    };
    gen.appliedSeq = gen.positions.receivedSeq;
    const store = createThreadStore(stateFromSnapshot(abacus));
    gen.store = store;
    gen.staged = {
      messages: snapshot.messages,
      subagents: [],
      status: "ready",
      sessionGenerating: active != null,
    };
    gen.paging =
      snapshot.page?.truncated === true
        ? { hasOlderMessages: true, olderCursor: snapshot.page.cursor }
        : { hasOlderMessages: false, olderCursor: null };

    let processingRunError = false;
    const dispatcher = createDispatcher({
      pre: (item) => {
        if (gen.g !== this.#gen || gen.abort.signal.aborted || this.#retired)
          return;
        processingRunError = item.event.type === "RUN_ERROR";
        if (item.event.type === "RUN_STARTED")
          gen.activeStart =
            gen.client?.getMessages().length ?? snapshot.messages.length;
        store.setState((state) =>
          applyEvent(state, item.seq, item.event, {
            live: item.seq > gen.positions.checkpoint,
          })
        );
      },
      error: (error) => this.#options.log?.("chat: event hook failed", error),
      post: (item) => {
        processingRunError = false;
        this.#post(gen, item.seq, item.event);
      },
    });
    gen.dispatcher = dispatcher;
    const guard =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): void => {
        if (gen.g !== this.#gen || gen.abort.signal.aborted || this.#retired)
          return;
        fn(...args);
      };
    const client = new ChatClient({
      threadId: this.threadId,
      initialMessages: snapshot.messages,
      queue: throwWhenBusy,
      connection: {
        subscribe: (signal?: AbortSignal) => dispatcher.stream(signal),
        send: () => {
          throw new Error("chat: send is not used");
        },
      },
      onMessagesChange: guard((messages: UIMessage[]) =>
        this.#fields(gen, {
          messages,
          subagents: gen.client?.getSubagents() ?? [],
        })
      ),
      onStatusChange: guard((status: ChatClientState) =>
        this.#fields(gen, { status })
      ),
      onSessionGeneratingChange: guard((sessionGenerating: boolean) =>
        this.#fields(gen, {
          sessionGenerating:
            sessionGenerating || gen.store?.state.runs.active != null,
        })
      ),
      onError: guard((error: Error) => {
        // ai-client 0.36 reports RUN_ERROR synchronously while consuming it.
        // Its terminal post-hook must still run, and the stream stays open.
        if (processingRunError) return;
        this.#options.log?.("chat: client error", error);
        dispatcher.close();
        gen.abort.abort();
        this.#recover();
      }),
    });
    gen.client = client;
    this.#options.onClient?.(client, gen.g);
    client.subscribe();

    void runPump({
      ai: this.#ai,
      threadId: this.threadId,
      activeRunId: active?.runId ?? null,
      positions: gen.positions,
      signal: gen.abort.signal,
      push: (seq, event) => dispatcher.push({ seq, event }),
      onConnection: (connection) => {
        if (gen.g !== this.#gen) return;
        this.#host({ connection });
      },
      onRecover: () => {
        if (gen.g !== this.#gen) return;
        this.#recover();
      },
      onNotFound: () => {
        if (gen.g !== this.#gen) return;
        this.#host({ notFound: true });
      },
      ...(this.#options.pumpRetryDelaysMs != null
        ? { retryDelaysMs: this.#options.pumpRetryDelaysMs }
        : {}),
    });

    this.#checkReady(gen);
  }

  #post(gen: Generation, seq: number, event: StreamChunk): void {
    if (gen.g !== this.#gen || gen.abort.signal.aborted || this.#retired)
      return;
    gen.appliedSeq = seq;
    // Reset only after accepted live progress has actually been consumed.
    if (seq > gen.positions.checkpoint) this.#recoveries = 0;
    this.#options.onConsumed?.(seq, gen.g);
    if (isTerminal(event)) {
      const messages = gen.client?.getMessages() ?? [];
      gen.store?.setState((state) =>
        recordTerminal(
          state,
          event,
          messages,
          Date.now(),
          gen.activeStart,
          seq > gen.positions.checkpoint
        )
      );
      this.#cancelAttempt += 1;
      if (this.#cancelTimer != null) {
        clearTimeout(this.#cancelTimer);
        this.#timers.delete(this.#cancelTimer);
      }
      if (gen.swapped) this.#host({ cancelling: false });
      this.#fields(gen, { sessionGenerating: false });
    } else if (event.type === "RUN_STARTED") {
      this.#fields(gen, { sessionGenerating: true });
    }
    if (customName(event) === "abacus.duplicate_echo") {
      // A retry's echo main dropped (§14.12): the entry stops waiting.
      const messageId = (event as { value?: { messageId?: unknown } }).value
        ?.messageId;
      if (typeof messageId === "string") {
        const entry = this.hostStore.state.outbox.find(
          (entry) => entry.id === messageId
        );
        if (entry != null) this.#echoed.add(entry.runId);
        if (this.#echoed.size > MAX_MESSAGES)
          this.#echoed.delete(this.#echoed.values().next().value!);
        this.#host({
          outbox: this.hostStore.state.outbox.filter(
            (entry) => entry.id !== messageId
          ),
        });
      }
    }
    if (
      customName(event) === "session.cleared" &&
      seq > gen.positions.checkpoint
    ) {
      // A reset: a fresh snapshot and client; pages and acks from before
      // are discarded (rev), pending admissions with it.
      this.#rev += 1;
      this.#echoed.clear();
      this.#host({ rev: this.#rev, outbox: [], cancelling: false });
      this.#start();
      return;
    }
    this.#checkReady(gen);
  }

  #checkReady(gen: Generation): void {
    if (gen.client == null) return;
    if (gen.appliedSeq < gen.positions.checkpoint) return;
    if (!gen.swapped) this.#swap(gen, false);
    else if (this.hostStore.state.partial) this.#host({ partial: false });
  }

  #swap(gen: Generation, partial: boolean): void {
    if (gen.store == null) return;
    gen.swapped = true;
    if (gen.capTimer != null) {
      clearTimeout(gen.capTimer);
      this.#timers.delete(gen.capTimer);
    }
    const old = this.#live;
    this.#live = gen;
    if (this.#pending === gen) this.#pending = null;
    const outbox = this.hostStore.state.outbox.filter(
      (entry) =>
        entry.retry ||
        !gen.staged.messages.some((message) => message.id === entry.id)
    );
    this.hostStore.setState((state) => ({
      ...state,
      ...gen.staged,
      ...gen.paging,
      outbox,
      gen: gen.g,
      store: gen.store!,
      client: gen.client,
      ready: true,
      partial,
      phase: "ready",
      error: null,
      notFound: false,
      older: "idle",
      cancelling: false,
    }));
    gen.ready.resolve();
    if (old != null && old !== gen) this.#teardown(old);
  }

  #fail(gen: Generation, error: unknown): void {
    gen.failed = true;
    this.#teardown(gen);
    if (this.#pending === gen) this.#pending = null;
    gen.ready.reject(error);
    gen.ready.promise.catch(() => {});
    this.#host({
      ...(this.hostStore.state.ready
        ? { connection: "error" as const }
        : { phase: "error" as const }),
      error,
      notFound: isNotFound(error),
    });
  }

  #recover(): void {
    const delays = this.#options.recoveryDelaysMs ?? RECOVERY_DELAYS_MS;
    const delay = delays[this.#recoveries];
    this.#recoveries += 1;
    if (delay == null) {
      const pending = this.#pending;
      if (pending != null && !pending.swapped)
        this.#fail(pending, new Error("chat: recovery exhausted"));
      this.#host({ connection: "error" });
      return;
    }
    this.#host({ connection: "reconnecting" });
    if (delay === 0) this.#start();
    else
      this.#after(delay, () => {
        if (!this.#retired) this.#start();
      });
  }

  #teardown(gen: Generation): void {
    gen.abort.abort();
    gen.dispatcher?.close();
    if (gen.capTimer != null) {
      clearTimeout(gen.capTimer);
      this.#timers.delete(gen.capTimer);
    }
    // Its callbacks are already inert (they check the generation, §3.3 step 7).
    gen.client?.unsubscribe();
    gen.client?.dispose();
  }

  #fields(gen: Generation, fields: Partial<GenerationFields>): void {
    if (!gen.swapped) {
      gen.staged = { ...gen.staged, ...fields };
      return;
    }
    const messages = fields.messages;
    this.hostStore.setState((state) => ({
      ...state,
      ...fields,
      outbox:
        messages == null
          ? state.outbox
          : state.outbox.filter(
              (entry) =>
                entry.retry ||
                !messages.some((message) => message.id === entry.id)
            ),
    }));
  }

  #mergeOutcomes(gen: Generation, outcomes: readonly RunOutcomeRecord[]): void {
    gen.store?.setState((state) => {
      const known = new Set(
        state.runs.outcomes.map((outcome) => outcome.runId)
      );
      const added = outcomes.filter((outcome) => !known.has(outcome.runId));
      if (added.length === 0) return state;
      return {
        ...state,
        runs: { ...state.runs, outcomes: [...added, ...state.runs.outcomes] },
      };
    });
  }

  #host(patch: Partial<HostState>): void {
    this.hostStore.setState((state) => ({ ...state, ...patch }));
  }

  #after(ms: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, ms);
    this.#timers.add(timer);
    return timer;
  }

  #createAdmission(): AdmissionHost {
    return {
      ai: this.#ai,
      threadId: this.threadId,
      onDefinitiveError: (error) => {
        if (isNotFound(error)) this.#host({ notFound: true });
      },
      token: () => ({ gen: this.#gen, rev: this.#rev, retired: this.#retired }),
      outbox: () => this.hostStore.state.outbox,
      setOutbox: (update) =>
        this.hostStore.setState((state) => ({
          ...state,
          outbox: update(state.outbox),
        })),
      echoed: (messageId, runId) =>
        runId != null
          ? this.#echoed.has(runId)
          : (this.#live?.client?.getMessages() ?? []).some(
              (message) => message.id === messageId
            ),
      reconcileDelaysMs: this.#options.reconcileDelaysMs ?? RECONCILE_DELAYS_MS,
      schedule: (ms, run) => {
        if (!this.#retired) this.#after(ms, run);
      },
      newId: (prefix) => `${prefix}-${this.#options.newId?.(prefix) ?? uuid()}`,
    };
  }
}
