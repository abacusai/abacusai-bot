/**
 * Main's AG-UI relay (agent spec §5.2, spec 00 A.3, spec 02 §14): everything
 * between an agent's `--wire agui` stdout and the renderer's `ai.*`
 * procedures. It implements the procedures' `AguiSource`:
 *
 * - **Wire selection.** One protocol per runtime (agent spec §2.1): a thread
 *   the new renderer has asked for (any `ai.*` call) is spawned `--wire agui`
 *   from then on; everything else stays `--wire ndjson`, so the shipped app,
 *   whose old renderer never calls `ai.*`, is unchanged. The
 *   `ABACUSAI_BOT_AGENT_WIRE=agui` env flag selects agui for every spawn
 *   (tests, dogfooding).
 * - **The relay.** Every AG-UI line goes to its thread's `ThreadRelay`
 *   (transcript, ring, run log, session state), which fans it out to the
 *   subscribers.
 * - **`ai.send`.** `UIMessage`s become AG-UI wire messages with the client's
 *   ids (`uiMessagesToWire`); the agent's `run.ack` for the run id is the
 *   answer. Idempotent by run id across agent incarnations: every run id's
 *   first ack is recorded, and a repeat answers `duplicate` + the original
 *   without writing `run` again (a repeat while the first awaits its ack
 *   waits for it).
 * - **The rest.** `cancel`, `respondPermission` and the queue map to agent
 *   commands; queue edits are checked against the live incarnation and the
 *   entry id here, since the agent's queue commands take an index.
 * - **Exits.** A runtime that exits with a run open gets a synthesized
 *   `RUN_ERROR` (agent spec §3.8: a signal exit writes no last words), and
 *   its pending permissions and queue are cleared on the stream.
 */
import { ORPCError } from "@orpc/server";
import { uiMessagesToWire, type UIMessage } from "@tanstack/ai";

import type {
  AiHydration,
  AiSendAck,
  AiSendInput,
  RunOutcomeRecord,
} from "#shared/contract";
import type { AgentSessionStatus } from "#shared/contracts";
import type { ThreadFileV2 } from "#shared/transcript/thread-file";

import type {
  AguiSource,
  AiRespondPermissionInput,
  SequencedChunk,
} from "../../rpc/ai/source";
import { DELIVERY } from "../../rpc/delivery";
import {
  badRequest,
  notFound,
  unavailable,
  type RpcError,
} from "../../rpc/errors";
import { drain, SubscriberQueue } from "../../rpc/subscriber-queue";
import type { AgentWire, NdjsonOrigin } from "../session/cli-manager-service";
import {
  SeqClock,
  terminalRunId,
  ThreadRelay,
  type RelayChunk,
  type RelayEvent,
  type ThreadHistory,
} from "./thread-relay";

/** What the relay needs from the rest of main. */
export interface AguiRelayHost {
  /** The session's workspace, or null for a thread main does not know. */
  workspaceOf(threadId: string): string | null;
  /** The thread's live runtime, if any. */
  runtime(
    threadId: string
  ): { wire: AgentWire; status: AgentSessionStatus } | null;
  /** Start the thread's agent (its wire comes from `wireFor`). */
  start(threadId: string): Promise<boolean>;
  /** One command on the runtime's stdin; false when it cannot be written. */
  send(threadId: string, command: object): boolean;
  /** Main's turn state: a turn was sent (legacy `sendAgentMessage` does this). */
  markSent(threadId: string): void;
  /** Main's turn state: the user stopped the turn (legacy `stopAgentTurn`). */
  markStopped(threadId: string): void;
}

/** The thread files (`ThreadStore`). */
export interface AguiThreadFiles {
  readCurrentFile(threadId: string): ThreadFileV2 | null;
  writeAgui(
    threadId: string,
    thread: {
      messages: UIMessage[];
      runs: unknown[];
      migratedFrom?: { updatedAt: string };
    }
  ): void;
  remove(threadId: string): void;
}

export interface AguiRelayOptions {
  host: AguiRelayHost;
  files: AguiThreadFiles;
  /** Defaults to `ABACUSAI_BOT_AGENT_WIRE === "agui"`. */
  aguiForEverySpawn?: boolean;
  /** How long `ai.send` waits for the runtime to be ready. */
  startTimeoutMs?: number;
  /** How long `ai.send` waits for `run.ack` after writing `run`. */
  ackTimeoutMs?: number;
  /** Loaded threads kept in memory beyond those in use. */
  maxIdleThreads?: number;
  log?: (message: string) => void;
}

type AckStatus = "started" | "queued" | "rejected";

interface AckRecord {
  status: AckStatus;
  reason?: AiSendAck["reason"];
  entryId?: string;
}

interface Waiter {
  resolve: (ack: AckRecord) => void;
  reject: (error: unknown) => void;
  promise: Promise<AckRecord>;
}

const waiter = (): Waiter => {
  let resolve!: (ack: AckRecord) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AckRecord>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // A waiter nobody awaits (a repeat that gave up) must not surface.
  promise.catch(() => undefined);
  return { resolve, reject, promise };
};

const timeoutError = (ms: number, message: string): RpcError =>
  new ORPCError("TIMEOUT", { status: 504, message, data: { ms } });

/** Run ids whose ack is remembered, per thread. */
const ACKS_KEPT = 2_000;
const POLL_MS = 25;

const REASONS = new Set([
  "regenerate_unsupported",
  "empty",
  "resume_unsupported",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object";

const toHistory = (file: ThreadFileV2 | null): ThreadHistory => {
  if (file == null) return { messages: [], runs: [] };
  if (file.source.kind === "agui")
    return {
      messages: file.messages,
      runs: Array.isArray(file.runs) ? (file.runs as RunOutcomeRecord[]) : [],
      ...(file.source.migratedFrom != null && {
        migratedFrom: file.source.migratedFrom,
      }),
    };
  return {
    messages: file.messages,
    runs: [],
    migratedFrom: { updatedAt: file.source.updatedAt },
  };
};

export class AguiRelayService implements AguiSource {
  /** This main process's relay lifetime; seqs are never reused within it. */
  readonly epoch = crypto.randomUUID();
  readonly #clock = new SeqClock();
  readonly #host: AguiRelayHost;
  readonly #files: AguiThreadFiles;
  readonly #aguiForEverySpawn: boolean;
  readonly #startTimeoutMs: number;
  readonly #ackTimeoutMs: number;
  readonly #maxIdleThreads: number;
  readonly #log: (message: string) => void;

  readonly #threads = new Map<string, ThreadRelay>();
  /** Threads the new renderer has asked for: their spawns speak AG-UI. */
  readonly #claimed = new Set<string>();
  /** runId → threadId, for `joinRun`. */
  readonly #runThreads = new Map<string, string>();
  /** threadId → runId → first ack. Survives respawns and eviction. */
  readonly #acks = new Map<string, Map<string, AckRecord>>();
  /** threadId → runId → the admission awaiting its ack. */
  readonly #waiting = new Map<string, Map<string, Waiter>>();

  constructor(options: AguiRelayOptions) {
    this.#host = options.host;
    this.#files = options.files;
    this.#aguiForEverySpawn =
      options.aguiForEverySpawn ??
      process.env.ABACUSAI_BOT_AGENT_WIRE === "agui";
    this.#startTimeoutMs = options.startTimeoutMs ?? 60_000;
    this.#ackTimeoutMs = options.ackTimeoutMs ?? 30_000;
    this.#maxIdleThreads = options.maxIdleThreads ?? 16;
    this.#log =
      options.log ?? ((message) => console.error(`[agui] ${message}`));
  }

  // ─── wiring from AgentManagerService ──────────────────────────────────

  /** `AgentManagerService.resolveWire`. */
  wireFor(threadId: string): AgentWire {
    return this.#aguiForEverySpawn || this.#claimed.has(threadId)
      ? "agui"
      : "ndjson";
  }

  /** `AgentManagerService.emitAgui`: one stdout line of an agui runtime. */
  ingest(
    threadId: string,
    event: Record<string, unknown>,
    origin?: NdjsonOrigin
  ): void {
    if (typeof event.type !== "string") return;
    const thread = this.#thread(threadId);
    const relayEvent = event as RelayEvent;
    const chunk = thread.ingest(relayEvent, origin?.runtime ?? null);
    if (chunk == null) return;

    if (
      relayEvent.type === "RUN_STARTED" &&
      typeof relayEvent.runId === "string"
    )
      this.#runThreads.set(relayEvent.runId, threadId);
    if (relayEvent.type === "CUSTOM" && relayEvent.name === "run.ack")
      this.#settleAck(threadId, relayEvent.value);
  }

  /** `AgentManagerService.emitAguiExit`: an agui runtime's process closed. */
  runtimeExited(
    threadId: string,
    exit: {
      origin: NdjsonOrigin;
      code: number | null;
      signal: NodeJS.Signals | null;
      requested: boolean;
    }
  ): void {
    const thread = this.#threads.get(threadId);
    const crashed =
      !exit.requested &&
      (exit.signal != null || (exit.code != null && exit.code !== 0));
    if (thread != null)
      thread.runtimeExited(
        exit.origin.runtime,
        crashed ? "agent_crashed" : "agent_exit",
        crashed
          ? `The agent stopped unexpectedly (${exit.signal ?? `exit code ${exit.code}`}).`
          : "The agent exited before the reply finished."
      );
    // An admission still waiting for its ack will not get one from this
    // process. Uncertain for the client: it re-sends the same run id.
    for (const [runId, pending] of this.#waiting.get(threadId) ?? []) {
      pending.reject(
        timeoutError(0, `The agent exited before it answered run ${runId}.`)
      );
    }
    this.#waiting.get(threadId)?.clear();
  }

  /**
   * Main's own terminal for the thread's open run, ahead of the agent's (the
   * inactivity watchdog, before it sends `stop`). First terminal wins.
   */
  failActiveRun(threadId: string, code: string, message: string): void {
    this.#threads.get(threadId)?.failActiveRun(code, message);
  }

  /** The conversation was reset or deleted by main (not via the agent). */
  clearThread(threadId: string): void {
    this.#threads.get(threadId)?.clearHistory();
  }

  /** Open `subscribe`/`joinRun` streams on a thread (leak checks, diagnostics). */
  listenerCount(threadId: string): number {
    return this.#threads.get(threadId)?.listenerCount ?? 0;
  }

  /** The session is gone: forget everything about the thread. */
  forgetThread(threadId: string): void {
    const thread = this.#threads.get(threadId);
    thread?.clearHistory();
    if (thread != null && thread.listenerCount === 0) this.#evict(threadId);
    this.#claimed.delete(threadId);
    this.#acks.delete(threadId);
  }

  // ─── AguiSource ───────────────────────────────────────────────────────

  subscribe(
    threadId: string,
    afterSeq: number | null,
    signal: AbortSignal
  ): AsyncIterable<SequencedChunk> {
    this.#claimed.add(threadId);
    const thread = this.#thread(threadId);
    const queue = new SubscriberQueue<SequencedChunk>({
      stream: "ai.subscribe",
      delivery: DELIVERY["ai.subscribe"],
    });
    const { replay, unsubscribe } = thread.subscribe(afterSeq, (chunk) =>
      queue.push(chunk)
    );
    // A port that closes before the first read never runs the generator's
    // `finally`: the listener must still go.
    signal.addEventListener("abort", unsubscribe, { once: true });
    const head = this.#clock.current;
    const control = (name: string, value: object): SequencedChunk => ({
      seq: null,
      event: {
        type: "CUSTOM",
        name,
        value,
        timestamp: Date.now(),
      } as unknown as SequencedChunk["event"],
    });
    const first: SequencedChunk[] = [
      control("abacus.subscribed", { seq: head, epoch: this.epoch }),
      ...(replay === "resync"
        ? [control("abacus.resync", { seq: head, epoch: this.epoch })]
        : replay),
    ];

    return (async function* () {
      try {
        yield* first;
        yield* drain(queue, signal, unsubscribe);
      } finally {
        unsubscribe();
      }
    })();
  }

  joinRun(runId: string, signal: AbortSignal): AsyncIterable<SequencedChunk> {
    const threadId = this.#runThreads.get(runId);
    const thread = threadId == null ? null : this.#threads.get(threadId);
    if (thread == null) return (async function* () {})();
    this.#claimed.add(thread.threadId);

    const queue = new SubscriberQueue<SequencedChunk>({
      stream: "ai.joinRun",
      delivery: DELIVERY["ai.joinRun"],
    });
    const isOwnTerminal = (chunk: RelayChunk): boolean => {
      const event = chunk.event as unknown as RelayEvent;
      return (
        (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") &&
        (terminalRunId(event) ?? runId) === runId
      );
    };
    const joined = thread.joinRun(runId, (chunk) => {
      queue.push(chunk);
      if (isOwnTerminal(chunk)) queue.end();
    });
    if (joined == null) return (async function* () {})();
    signal.addEventListener("abort", joined.unsubscribe, { once: true });

    return (async function* () {
      try {
        for (const chunk of joined.replay) {
          yield chunk;
          if (isOwnTerminal(chunk)) return;
        }
        if (joined.ended) return;
        yield* drain(queue, signal, joined.unsubscribe);
      } finally {
        joined.unsubscribe();
      }
    })();
  }

  async hydrate(threadId: string): Promise<AiHydration> {
    this.#claimed.add(threadId);
    const { messages, activeRun, snapshot } =
      this.#thread(threadId).checkpoint();
    return { messages, activeRun, interrupts: null, abacus: snapshot };
  }

  async send(input: AiSendInput): Promise<AiSendAck> {
    const { threadId, runId } = input;
    this.#claimed.add(threadId);
    if (this.#host.workspaceOf(threadId) == null)
      throw notFound("session", threadId);

    const conversationId = input.forwardedProps?.conversationId;
    if (conversationId != null && conversationId !== threadId)
      throw badRequest("forwardedProps.conversationId is not this thread");

    const repeat = await this.#repeatOf(threadId, runId);
    if (repeat != null) return repeat;

    await this.#ensureAguiRuntime(threadId);

    // Checked again: another attempt may have written it while this one
    // waited for the runtime.
    const late = await this.#repeatOf(threadId, runId);
    if (late != null) return late;

    const pending = waiter();
    this.#waitingFor(threadId).set(runId, pending);
    this.#host.markSent(threadId);
    if (!this.#host.send(threadId, this.#runCommand(input))) {
      this.#waitingFor(threadId).delete(runId);
      throw unavailable("The agent is not accepting input", 1_000);
    }

    // A timeout rejects the admission itself, so a repeat waiting on it
    // gets the same uncertain answer; a late ack is still recorded.
    const timer = setTimeout(
      () =>
        pending.reject(
          timeoutError(
            this.#ackTimeoutMs,
            `The agent did not acknowledge run ${runId}`
          )
        ),
      this.#ackTimeoutMs
    );
    try {
      const ack = await pending.promise;
      if (
        ack.status === "rejected" &&
        this.#threads.get(threadId)?.activeRunId == null
      )
        // Nothing runs: undo markSent's pending phase and its watchdog.
        this.#host.markStopped(threadId);
      return { runId, ...ack };
    } finally {
      clearTimeout(timer);
      if (this.#waiting.get(threadId)?.get(runId) === pending)
        this.#waiting.get(threadId)?.delete(runId);
    }
  }

  async cancel(threadId: string, runId?: string): Promise<void> {
    const runtime = this.#host.runtime(threadId);
    if (
      runtime == null ||
      runtime.status === "stopped" ||
      runtime.status === "error"
    )
      return;
    this.#requireAgui(threadId);
    const thread = this.#threads.get(threadId);
    const current =
      runId == null ||
      thread?.activeRunId === runId ||
      this.#waiting.get(threadId)?.has(runId) === true ||
      (this.#acks.get(threadId)?.get(runId)?.status === "started" &&
        thread?.hasFinished(runId) !== true);
    // A stale id is still written (the agent ignores it, agent spec §3.8),
    // but must not suppress the running turn's events in main's taps.
    if (current) this.#host.markStopped(threadId);
    this.#write(
      threadId,
      runId == null ? { type: "cancel" } : { type: "cancel", runId }
    );
  }

  async respondPermission(input: AiRespondPermissionInput): Promise<void> {
    if (input.lineage.threadId !== input.threadId)
      throw badRequest("The permission belongs to another thread");
    this.#requireAgui(input.threadId);
    this.#write(input.threadId, {
      type: "permission.respond",
      lineage: input.lineage,
      decision: input.decision,
    });
  }

  readonly queue: AguiSource["queue"] = {
    enqueue: async (threadId, message) => {
      this.#requireAgui(threadId);
      this.#write(threadId, { type: "enqueue", message, hidden: false });
    },
    update: async ({ threadId, incarnation, entryId, message }) => {
      const index = this.#queueIndex(threadId, incarnation, entryId, "update");
      if (index != null)
        this.#write(threadId, { type: "update_queue_item", index, message });
    },
    remove: async ({ threadId, incarnation, entryId }) => {
      const index = this.#queueIndex(threadId, incarnation, entryId, "remove");
      if (index != null)
        this.#write(threadId, { type: "remove_from_queue", index });
    },
    clear: async (threadId) => {
      this.#requireAgui(threadId);
      this.#write(threadId, { type: "clear_queue" });
    },
    dequeue: async (threadId) => {
      this.#requireAgui(threadId);
      this.#write(threadId, { type: "dequeue" });
    },
  };

  // ─── internals ────────────────────────────────────────────────────────

  #thread(threadId: string): ThreadRelay {
    const existing = this.#threads.get(threadId);
    if (existing != null) return existing;

    let file: ThreadFileV2 | null = null;
    try {
      file = this.#files.readCurrentFile(threadId);
    } catch (error) {
      this.#log(
        `${threadId}: reading the thread file failed: ${String(error)}`
      );
    }
    const thread = new ThreadRelay({
      threadId,
      clock: this.#clock,
      epoch: this.epoch,
      history: toHistory(file),
      persist: (history) =>
        this.#files.writeAgui(threadId, {
          messages: history.messages,
          runs: history.runs,
          ...(history.migratedFrom != null && {
            migratedFrom: history.migratedFrom,
          }),
        }),
      remove: () => this.#files.remove(threadId),
      log: this.#log,
    });
    this.#threads.set(threadId, thread);
    this.#evictIdle();
    return thread;
  }

  /** Threads nobody watches, with no run and no runtime, beyond the budget. */
  #evictIdle(): void {
    const idle = [...this.#threads.values()]
      .filter(
        (thread) =>
          thread.listenerCount === 0 &&
          thread.activeRunId == null &&
          thread.runtime == null &&
          (this.#waiting.get(thread.threadId)?.size ?? 0) === 0
      )
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const thread of idle.slice(
      0,
      Math.max(0, idle.length - this.#maxIdleThreads)
    ))
      this.#evict(thread.threadId);
  }

  #evict(threadId: string): void {
    this.#threads.delete(threadId);
    for (const [runId, owner] of this.#runThreads)
      if (owner === threadId) this.#runThreads.delete(runId);
  }

  #waitingFor(threadId: string): Map<string, Waiter> {
    let map = this.#waiting.get(threadId);
    if (map == null) {
      map = new Map();
      this.#waiting.set(threadId, map);
    }
    return map;
  }

  /** A repeated run id's answer, or null for a new one. */
  async #repeatOf(threadId: string, runId: string): Promise<AiSendAck | null> {
    const recorded = this.#acks.get(threadId)?.get(runId);
    if (recorded != null) return this.#duplicate(runId, recorded);
    const inflight = this.#waiting.get(threadId)?.get(runId);
    if (inflight != null) return this.#duplicate(runId, await inflight.promise);
    // A run main saw start without seeing its ack (an ack line lost to a
    // respawn): it is not new either.
    if (this.#runThreads.get(runId) === threadId)
      return this.#duplicate(runId, { status: "started" });
    return null;
  }

  #duplicate(runId: string, first: AckRecord): AiSendAck {
    return {
      runId,
      status: "duplicate",
      original: first.status,
      ...(first.reason != null && { reason: first.reason }),
      ...(first.entryId != null && { entryId: first.entryId }),
    };
  }

  #settleAck(threadId: string, value: unknown): void {
    if (!isRecord(value) || typeof value.runId !== "string") return;
    const runId = value.runId;
    const status = value.status;
    // The agent's own in-incarnation duplicate: the first answer was recorded.
    const ack: AckRecord =
      status === "queued" || status === "rejected" || status === "started"
        ? {
            status,
            ...(typeof value.reason === "string" &&
              REASONS.has(value.reason) && {
                reason: value.reason as AiSendAck["reason"],
              }),
            ...(typeof value.entryId === "string" && {
              entryId: value.entryId,
            }),
          }
        : (this.#acks.get(threadId)?.get(runId) ?? { status: "started" });

    // `thread_mismatch` means main built a bad envelope: never recorded, so
    // a corrected retry of the run id is not answered `duplicate`.
    if (!(status === "rejected" && value.reason === "thread_mismatch")) {
      let acks = this.#acks.get(threadId);
      if (acks == null) {
        acks = new Map();
        this.#acks.set(threadId, acks);
      }
      if (!acks.has(runId)) {
        acks.set(runId, ack);
        if (acks.size > ACKS_KEPT) acks.delete(acks.keys().next().value!);
      }
    }
    this.#waiting.get(threadId)?.get(runId)?.resolve(ack);
  }

  #runCommand(input: AiSendInput): object {
    const forwarded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.forwardedProps ?? {})) {
      // `whenBusy` is gone (spec 02 §14.5): the host queue decides.
      if (key === "whenBusy" || value === undefined) continue;
      forwarded[key] = value;
    }
    return {
      type: "run",
      input: {
        threadId: input.threadId,
        runId: input.runId,
        ...(input.parentRunId != null && { parentRunId: input.parentRunId }),
        state: {},
        // The client's message ids survive: the agent echoes the newest user
        // message under its own id (spec 02 §14.2).
        messages: uiMessagesToWire(input.messages as unknown as UIMessage[]),
        tools: [],
        context: [],
        ...(input.resume != null && { resume: input.resume }),
        ...(Object.keys(forwarded).length > 0 && { forwardedProps: forwarded }),
      },
    };
  }

  /** Waits for an agui runtime for the thread, starting one if none runs. */
  async #ensureAguiRuntime(threadId: string): Promise<void> {
    const deadline = Date.now() + this.#startTimeoutMs;
    let started = false;

    for (;;) {
      const runtime = this.#host.runtime(threadId);
      const status = runtime?.status ?? "stopped";
      if (
        runtime != null &&
        runtime.wire !== "agui" &&
        status !== "stopped" &&
        status !== "error"
      )
        throw unavailable(
          "This session's agent speaks the legacy protocol; stop it and send again"
        );
      if (status === "running") return;
      if (status === "stopped" || status === "error") {
        if (started) throw unavailable("The agent did not start", 1_000);
        started = true;
        if (!(await this.#host.start(threadId)))
          throw unavailable("The agent could not be started", 1_000);
        continue;
      }
      // starting, or stopping (a respawn follows the close).
      if (Date.now() > deadline)
        throw timeoutError(
          this.#startTimeoutMs,
          "The agent did not become ready"
        );
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  #requireAgui(threadId: string): void {
    const runtime = this.#host.runtime(threadId);
    if (
      runtime == null ||
      (runtime.status !== "running" && runtime.status !== "starting")
    )
      throw unavailable("The agent is not running", 1_000);
    if (runtime.wire !== "agui")
      throw unavailable("This session's agent speaks the legacy protocol");
  }

  #write(threadId: string, command: object): void {
    if (!this.#host.send(threadId, command))
      throw unavailable("The agent is not accepting input", 1_000);
  }

  /**
   * The index the agent's queue command needs, checked against what main
   * last saw from the live process. A stale incarnation or a gone entry is
   * answered on the stream (`queue.command_rejected`) and nothing is sent.
   */
  #queueIndex(
    threadId: string,
    incarnation: string,
    entryId: string,
    command: "update" | "remove"
  ): number | null {
    this.#requireAgui(threadId);
    const thread = this.#thread(threadId);
    if (thread.incarnation !== incarnation) {
      thread.rejectQueueCommand(entryId, command, "incarnation");
      return null;
    }
    const index = thread.queue.findIndex((entry) => entry.id === entryId);
    if (index === -1) {
      thread.rejectQueueCommand(entryId, command, "not_found");
      return null;
    }
    return index;
  }
}
