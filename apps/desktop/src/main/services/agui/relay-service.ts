/**
 * Main's AG-UI relay (agent spec §5.2, spec 00 A.3, spec 02 §14): everything
 * between an agent's `--wire agui` stdout and the renderer's `ai.*`
 * procedures. It implements the procedures' `AguiSource`:
 *
 * - **Wire selection.** One protocol per runtime (agent spec §2.1). In the
 *   new-renderer build (`RENDERER_GENERATION === "wco"`) every spawn is
 *   `--wire agui`: anything spawned before the renderer's first `ai.*` call
 *   (a routine, a bot reply, a restored session) must be drivable from it.
 *   In the legacy build every spawn stays `--wire ndjson` (its renderer never
 *   calls `ai.*`), except a thread the new renderer has asked for and, in an
 *   unpackaged app only, `ABACUSAI_BOT_AGENT_WIRE=agui` (`defaultWire`).
 * - **The relay.** Every AG-UI line goes to its thread's `ThreadRelay`
 *   (transcript, ring, run log, session state), which fans it out to the
 *   subscribers.
 * - **`ai.send`.** `UIMessage`s become AG-UI wire messages with the client's
 *   ids (`uiMessagesToWire`), converted before anything is reserved (a
 *   conversion failure is `BAD_REQUEST`); the agent's `run.ack` for the run
 *   id is the answer. Idempotent by run id across agent incarnations: the
 *   duplicate check and the reservation are one synchronous step, every run
 *   id's first ack is recorded, and a repeat answers `duplicate` + the
 *   original without writing `run` again (a repeat while the first is in
 *   flight waits for it).
 * - **The rest.** `cancel`, `respondPermission` and the queue map to agent
 *   commands; queue edits go to the agent by incarnation and entry id, which
 *   it checks and applies atomically (spec 02 §14.6).
 * - **Exits.** A runtime that exits with a run open gets a synthesized
 *   `RUN_ERROR` (agent spec §3.8: a signal exit writes no last words), and
 *   its pending permissions, queue and activity are cleared on the stream;
 *   only the admissions written to that process are answered uncertain.
 */
import { ORPCError } from "@orpc/server";
import { uiMessagesToWire, type UIMessage } from "@tanstack/ai";

import type {
  AiHydration,
  AiSendAck,
  AiSendInput,
  AttentionEvent,
  AttentionSummary,
  RunOutcomeRecord,
} from "#shared/contract";
import type { AgentSessionStatus, SessionOwner } from "#shared/contracts";
import type { ThreadFileV2 } from "#shared/transcript/thread-file";

import type {
  AguiSource,
  AiRespondPermissionInput,
  SequencedChunk,
  SequencedNotice,
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
  type PendingPermissionsInfo,
  type RelayChunk,
  type RelayEvent,
  type RunFinishedInfo,
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
  /**
   * One command on the live runtime's stdin. Returns the process it was
   * written to (the identity `ingest`'s origin carries), or null when it
   * could not be written. That process, not the one stdout last named, is
   * the one whose exit leaves the command unanswered: a replacement can be
   * running (its compat `ready` seen) before its `wire.hello` arrives.
   */
  send(threadId: string, command: object): object | null;
  /** Main's turn state: a turn was sent (legacy `sendAgentMessage` does this). */
  markSent(threadId: string): void;
  /** Main's turn state: the user stopped the turn (legacy `stopAgentTurn`). */
  markStopped(threadId: string): void;
  /**
   * The session's parentage for `ai.runFinished` (bot owner, routine id).
   * Absent: both null.
   */
  ownerOf?(threadId: string): {
    owner: SessionOwner | null;
    routineId: string | null;
  };
  /**
   * Every accepted `ai.send`, just before `run` is written (spec 03 §24.10 c):
   * the host may re-pin the running agent's model. Errors are logged.
   */
  beforeRun?(threadId: string): Promise<void>;
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
  /** Every spawn speaks AG-UI (`defaultWire`). Defaults to false. */
  aguiForEverySpawn?: boolean;
  /** How long `ai.send` waits for the runtime to be ready. */
  startTimeoutMs?: number;
  /** How long `ai.send` waits for `run.ack` after writing `run`. */
  ackTimeoutMs?: number;
  /** Loaded threads kept in memory beyond those in use. */
  maxIdleThreads?: number;
  log?: (message: string) => void;
}

/**
 * Whether every spawn speaks AG-UI: always in the new-renderer build; in
 * the legacy build only with `ABACUSAI_BOT_AGENT_WIRE=agui` in an unpackaged
 * app (tests, dogfooding). A packaged legacy app ignores the variable: its
 * renderer could not show an AG-UI turn, and the compat stream it needs is
 * withheld from it for agui runtimes.
 */
export const defaultWire = (options: {
  generation: "legacy" | "wco";
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): boolean => {
  if (options.generation === "wco") return true;
  const requested = options.env.ABACUSAI_BOT_AGENT_WIRE === "agui";
  if (requested && options.isPackaged) {
    options.log?.(
      "ABACUSAI_BOT_AGENT_WIRE=agui is ignored in a packaged legacy build"
    );
    return false;
  }
  return requested;
};

type AckStatus = "started" | "queued" | "rejected";

interface AckRecord {
  /** `unknown`: the agent said `duplicate` for a run main has no answer for. */
  status: AckStatus | "unknown";
  reason?: AiSendAck["reason"];
  entryId?: string;
}

interface Waiter {
  resolve: (ack: AckRecord) => void;
  reject: (error: unknown) => void;
  promise: Promise<AckRecord>;
  /**
   * The process `run` was written to, as the host reports it; undefined
   * until written. Only that process's exit makes the admission uncertain.
   */
  runtime?: object;
  /** Why the admission was abandoned before it was written (the session went). */
  abandoned?: unknown;
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

/** Run ids whose first ack is remembered, over every thread. */
const ACKS_KEPT = 10_000;
/** Run ids seen starting (answered `duplicate` without an ack), over every thread. */
const STARTED_RUNS_KEPT = 10_000;
const POLL_MS = 25;
/** Run-finished notices kept for a `lastEventId` resume, over every thread. */
export const NOTICES_KEPT = 1_000;

const REASONS = new Set([
  "regenerate_unsupported",
  "empty",
  "resume_unsupported",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object";

const runKey = (threadId: string, runId: string): string =>
  `${threadId}\u0000${runId}`;

/** Insertion-ordered set/map trimming: the oldest entries go first. */
const trim = (collection: Map<string, unknown> | Set<string>, max: number) => {
  while (collection.size > max)
    collection.delete(collection.keys().next().value!);
};

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
    v1Derived: true,
  };
};

/** The newest user message's id in an `ai.send`, whose echo the run carries. */
const newestUserId = (messages: AiSendInput["messages"]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1)
    if (messages[index]!.role === "user") return messages[index]!.id;
  return null;
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
  /** runId → threadId, while the run's log is joinable (`joinRun`). */
  readonly #runOwners = new Map<string, string>();
  /** `thread\0run` of runs seen starting: not new for `ai.send`. Bounded. */
  readonly #startedRuns = new Set<string>();
  /** `thread\0run` → first ack. Survives respawns and eviction. Bounded. */
  readonly #acks = new Map<string, AckRecord>();
  /** threadId → runId → the admission in flight (reserved, then written). */
  readonly #waiting = new Map<string, Map<string, Waiter>>();
  /** threadId → run ids acked `started` whose `RUN_STARTED` has not come. */
  readonly #awaitingStart = new Map<string, Set<string>>();
  /** threadId → the runtime start in progress (one at a time per thread). */
  readonly #starting = new Map<string, Promise<void>>();

  /** The newest run-finished notices, oldest first, for `lastEventId`. */
  readonly #notices: SequencedNotice[] = [];
  readonly #noticeListeners = new Set<(notice: SequencedNotice) => void>();
  /** `ai.attention`'s table: threads with answerable permissions. */
  readonly #attention = new Map<string, AttentionSummary>();
  /** threadId → permission id → when main first saw it pending. */
  readonly #pendingSince = new Map<string, Map<string, number>>();
  #attentionRevision = 0;
  readonly #attentionListeners = new Set<(event: AttentionEvent) => void>();

  constructor(options: AguiRelayOptions) {
    this.#host = options.host;
    this.#files = options.files;
    this.#aguiForEverySpawn = options.aguiForEverySpawn ?? false;
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
    ) {
      this.#runOwners.set(relayEvent.runId, threadId);
      this.#startedRuns.add(runKey(threadId, relayEvent.runId));
      trim(this.#startedRuns, STARTED_RUNS_KEPT);
      const awaiting = this.#awaitingStart.get(threadId);
      awaiting?.delete(relayEvent.runId);
      if (awaiting?.size === 0) this.#awaitingStart.delete(threadId);
    }
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
    const current =
      thread?.runtimeExited(
        exit.origin.runtime,
        crashed ? "agent_crashed" : "agent_exit",
        crashed
          ? `The agent stopped unexpectedly (${exit.signal ?? `exit code ${exit.code}`}).`
          : "The agent exited before the reply finished."
      ) ?? true;
    // A run acked `started` by this process that never opened will not.
    if (current) this.#awaitingStart.delete(threadId);
    // Only the admissions written to this process are left without an ack;
    // one still waiting for a runtime, or written to its replacement, keeps
    // waiting. Uncertain for the client: it re-sends the same run id.
    const waiting = this.#waiting.get(threadId);
    for (const [runId, pending] of waiting ?? []) {
      if (pending.runtime !== exit.origin.runtime) continue;
      pending.reject(
        timeoutError(0, `The agent exited before it answered run ${runId}.`)
      );
      this.#release(threadId, runId, pending);
    }
  }

  /**
   * Main's own terminal for the thread's open run, ahead of the agent's (the
   * inactivity watchdog, before it sends `stop`). First terminal wins.
   */
  failActiveRun(threadId: string, code: string, message: string): void {
    this.#threads.get(threadId)?.failActiveRun(code, message);
  }

  /** The conversation was reset by main (not via the agent). */
  clearThread(threadId: string): void {
    this.#threads.get(threadId)?.clearByMain();
  }

  /** Threads with per-thread admission bookkeeping (leak checks, diagnostics). */
  get admissionThreads(): number {
    return new Set([...this.#waiting.keys(), ...this.#awaitingStart.keys()])
      .size;
  }

  /** Open `subscribe`/`joinRun` streams on a thread (leak checks, diagnostics). */
  listenerCount(threadId: string): number {
    return this.#threads.get(threadId)?.listenerCount ?? 0;
  }

  /** The session is gone: forget everything about the thread. */
  forgetThread(threadId: string): void {
    // Admissions still in flight get a definitive answer now: nothing will
    // ack them, and one not yet written must not start the agent again.
    const waiting = this.#waiting.get(threadId);
    this.#waiting.delete(threadId);
    for (const pending of waiting?.values() ?? []) {
      const gone = notFound("session", threadId);
      pending.abandoned = gone;
      pending.reject(gone);
    }
    const thread = this.#threads.get(threadId);
    thread?.clearByMain();
    if (thread != null && thread.listenerCount === 0) this.#evict(threadId);
    this.#claimed.delete(threadId);
    const prefix = runKey(threadId, "");
    for (const key of this.#acks.keys())
      if (key.startsWith(prefix)) this.#acks.delete(key);
    for (const key of this.#startedRuns)
      if (key.startsWith(prefix)) this.#startedRuns.delete(key);
    this.#awaitingStart.delete(threadId);
    // Session deletion: nothing of it waits on the user any more.
    this.#setAttention(threadId, { incarnation: null, items: [] });
  }

  // ─── run-finished notices and attention ───────────────────────────────

  runFinished(
    afterSeq: number | null,
    signal: AbortSignal
  ): AsyncIterable<SequencedNotice> {
    const queue = new SubscriberQueue<SequencedNotice>({
      stream: "ai.runFinished",
      delivery: DELIVERY["ai.runFinished"],
    });
    // Registered and replayed in one synchronous step: nothing between.
    const listener = (notice: SequencedNotice): void => {
      queue.push(notice);
      if (queue.failed) unsubscribe();
    };
    const unsubscribe = (): void => {
      this.#noticeListeners.delete(listener);
    };
    this.#noticeListeners.add(listener);
    signal.addEventListener("abort", unsubscribe, { once: true });
    const replay =
      afterSeq == null || afterSeq > this.#clock.current
        ? []
        : this.#notices.filter((notice) => notice.seq > afterSeq);

    return (async function* () {
      try {
        yield* replay;
        yield* drain(queue, signal, unsubscribe);
      } finally {
        unsubscribe();
      }
    })();
  }

  attention(signal: AbortSignal): AsyncIterable<AttentionEvent> {
    const queue = new SubscriberQueue<AttentionEvent>({
      stream: "ai.attention",
      delivery: DELIVERY["ai.attention"],
    });
    const listener = (event: AttentionEvent): void => {
      queue.push(event);
      if (queue.failed) unsubscribe();
    };
    const unsubscribe = (): void => {
      this.#attentionListeners.delete(listener);
    };
    // The snapshot and the registration are one synchronous step.
    this.#attentionListeners.add(listener);
    const snapshot: AttentionEvent = {
      type: "snapshot",
      revision: this.#attentionRevision,
      items: [...this.#attention.values()].map((item) => ({ ...item })),
    };
    signal.addEventListener("abort", unsubscribe, { once: true });

    return (async function* () {
      try {
        yield snapshot;
        yield* drain(queue, signal, unsubscribe);
      } finally {
        unsubscribe();
      }
    })();
  }

  #publishRunFinished(threadId: string, info: RunFinishedInfo): void {
    let parentage: { owner: SessionOwner | null; routineId: string | null } = {
      owner: null,
      routineId: null,
    };
    try {
      parentage = this.#host.ownerOf?.(threadId) ?? parentage;
    } catch (error) {
      this.#log(
        `${threadId}: reading the session owner failed: ${String(error)}`
      );
    }
    const notice: SequencedNotice = {
      seq: info.seq,
      notice: {
        threadId,
        runId: info.runId,
        outcome: info.outcome,
        ...(info.errorCode != null && { errorCode: info.errorCode }),
        hasVisibleAssistantText: info.hasVisibleAssistantText,
        owner: parentage.owner,
        routineId: parentage.routineId,
        at: info.at,
      },
    };
    this.#notices.push(notice);
    if (this.#notices.length > NOTICES_KEPT)
      this.#notices.splice(0, this.#notices.length - NOTICES_KEPT);
    for (const listener of Array.from(this.#noticeListeners)) listener(notice);
  }

  /** The thread's answerable set changed: its attention row follows. */
  #setAttention(threadId: string, pending: PendingPermissionsInfo): void {
    const items = pending.items;
    const previous = this.#attention.get(threadId);
    if (items.length === 0) {
      this.#pendingSince.delete(threadId);
      if (previous == null) return;
      this.#attention.delete(threadId);
      this.#emitAttention({
        type: "remove",
        revision: ++this.#attentionRevision,
        threadId,
      });
      return;
    }

    const incarnation =
      pending.incarnation ??
      items[0]!.metadata.abacus.lineage.incarnation ??
      "";
    // Another process's pending entries are not this one's: its item goes.
    if (previous != null && previous.incarnation !== incarnation) {
      this.#pendingSince.delete(threadId);
      this.#attention.delete(threadId);
      this.#emitAttention({
        type: "remove",
        revision: ++this.#attentionRevision,
        threadId,
      });
    }
    const now = Date.now();
    const seen = this.#pendingSince.get(threadId) ?? new Map<string, number>();
    const next = new Map<string, number>();
    for (const item of items) {
      const id = item.metadata.abacus.lineage.permissionId;
      next.set(id, seen.get(id) ?? now);
    }
    this.#pendingSince.set(threadId, next);
    const oldest = [...items].sort(
      (a, b) =>
        next.get(a.metadata.abacus.lineage.permissionId)! -
        next.get(b.metadata.abacus.lineage.permissionId)!
    )[0]!;
    const questions = items.filter(
      (item) => item.reason === "abacus:question"
    ).length;
    const item: AttentionSummary = {
      threadId,
      incarnation,
      questions,
      approvals: items.length - questions,
      oldestAt: next.get(oldest.metadata.abacus.lineage.permissionId)!,
      firstTitle:
        typeof oldest.message === "string" && oldest.message !== ""
          ? oldest.message
          : null,
    };
    this.#attention.set(threadId, item);
    this.#emitAttention({
      type: "upsert",
      revision: ++this.#attentionRevision,
      item,
    });
  }

  #emitAttention(event: AttentionEvent): void {
    for (const listener of Array.from(this.#attentionListeners))
      listener(event);
  }

  // ─── AguiSource ───────────────────────────────────────────────────────

  subscribe(
    threadId: string,
    afterSeq: number | null,
    signal: AbortSignal,
    epoch?: string
  ): AsyncIterable<SequencedChunk> {
    const thread = this.#known(threadId);
    const queue = new SubscriberQueue<SequencedChunk>({
      stream: "ai.subscribe",
      delivery: DELIVERY["ai.subscribe"],
    });
    let unsubscribe = (): void => undefined;
    const subscribed = thread.subscribe(afterSeq, (chunk) => {
      queue.push(chunk);
      // Overflowed while the consumer is parked: stop listening now.
      if (queue.failed) unsubscribe();
    });
    unsubscribe = subscribed.unsubscribe;
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
    // A resume point from another relay lifetime names other events.
    const replay =
      afterSeq != null && epoch != null && epoch !== this.epoch
        ? "resync"
        : subscribed.replay;
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
    const threadId = this.#runOwners.get(runId);
    const thread = threadId == null ? null : this.#threads.get(threadId);
    if (thread == null) return (async function* () {})();

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
    let unsubscribe = (): void => undefined;
    const joined = thread.joinRun(runId, (chunk) => {
      queue.push(chunk);
      if (queue.failed) unsubscribe();
      else if (isOwnTerminal(chunk)) queue.end();
    });
    if (joined == null) return (async function* () {})();
    unsubscribe = joined.unsubscribe;
    this.#claimed.add(thread.threadId);
    signal.addEventListener("abort", unsubscribe, { once: true });

    return (async function* () {
      try {
        for (const chunk of joined.replay) {
          yield chunk;
          if (isOwnTerminal(chunk)) return;
        }
        if (joined.ended) return;
        yield* drain(queue, signal, unsubscribe);
      } finally {
        unsubscribe();
      }
    })();
  }

  async hydrate(threadId: string): Promise<AiHydration> {
    const { messages, activeRun, snapshot } =
      this.#known(threadId).checkpoint();
    return { messages, activeRun, interrupts: null, abacus: snapshot };
  }

  async send(input: AiSendInput): Promise<AiSendAck> {
    const { threadId, runId } = input;
    if (this.#host.workspaceOf(threadId) == null)
      throw notFound("session", threadId);
    this.#claimed.add(threadId);

    const conversationId = input.forwardedProps?.conversationId;
    if (conversationId != null && conversationId !== threadId)
      throw badRequest("forwardedProps.conversationId is not this thread");

    // Converted before anything is reserved: a message main cannot convert
    // is a definitive BAD_REQUEST, and nothing is left waiting.
    let command: object;
    try {
      command = this.#runCommand(input);
    } catch (error) {
      throw badRequest(
        `The messages could not be converted: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // The duplicate check and the reservation are one synchronous step: a
    // simultaneous send of the same run id finds this reservation.
    const repeat = this.#repeatOf(threadId, runId);
    if (repeat != null) return repeat;
    const pending = waiter();
    this.#waitingFor(threadId).set(runId, pending);

    let marked = false;
    let written = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#ensureAguiRuntime(threadId);
      // The session was forgotten while the runtime started.
      if (pending.abandoned !== undefined) throw pending.abandoned;

      // The running agent takes the effective model before this run.
      if (this.#host.beforeRun != null) {
        try {
          await this.#host.beforeRun(threadId);
        } catch (error) {
          this.#log(
            `${threadId}: re-pinning before the run failed: ${String(error)}`
          );
        }
        if (pending.abandoned !== undefined) throw pending.abandoned;
      }

      const thread = this.#thread(threadId);
      const echo = newestUserId(input.messages);
      if (echo != null) thread.expectEcho(runId, echo);
      this.#host.markSent(threadId);
      marked = true;
      // The process the host wrote to, which may not have said hello yet.
      const target = this.#host.send(threadId, command);
      if (target == null)
        throw unavailable("The agent is not accepting input", 1_000);
      pending.runtime = target;
      written = true;

      // A timeout rejects the admission itself, so a repeat waiting on it
      // gets the same uncertain answer; a late ack is still recorded.
      timer = setTimeout(
        () =>
          pending.reject(
            timeoutError(
              this.#ackTimeoutMs,
              `The agent did not acknowledge run ${runId}`
            )
          ),
        this.#ackTimeoutMs
      );
      const ack = await pending.promise;
      if (ack.status === "rejected" && thread.activeRunId == null)
        // Nothing runs: undo markSent's pending phase and its watchdog.
        this.#host.markStopped(threadId);
      return this.#answer(runId, ack, false);
    } catch (error) {
      if (!written) {
        // Nothing reached the agent: the same definitive answer for any
        // repeat awaiting this admission, and main's turn state undone.
        pending.reject(error);
        if (marked) this.#host.markStopped(threadId);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.#release(threadId, runId, pending);
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
    // The open run, or an admission that will open it: in flight, or acked
    // `started` and not yet seen starting. Anything else is stale.
    const current =
      runId == null ||
      thread?.activeRunId === runId ||
      this.#waiting.get(threadId)?.has(runId) === true ||
      this.#awaitingStart.get(threadId)?.has(runId) === true;
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
      if (this.#queueTarget(threadId, incarnation, entryId, "update"))
        this.#write(threadId, {
          type: "queue.update",
          incarnation,
          entryId,
          message,
        });
    },
    remove: async ({ threadId, incarnation, entryId }) => {
      if (this.#queueTarget(threadId, incarnation, entryId, "remove"))
        this.#write(threadId, { type: "queue.remove", incarnation, entryId });
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

  /** A thread main knows (NOT_FOUND otherwise), claimed and loaded. */
  #known(threadId: string): ThreadRelay {
    if (this.#host.workspaceOf(threadId) == null)
      throw notFound("session", threadId);
    this.#claimed.add(threadId);
    return this.#thread(threadId);
  }

  #thread(threadId: string): ThreadRelay {
    const existing = this.#threads.get(threadId);
    if (existing != null) return existing;

    const read = (): ThreadFileV2 | null => {
      try {
        return this.#files.readCurrentFile(threadId);
      } catch (error) {
        this.#log(
          `${threadId}: reading the thread file failed: ${String(error)}`
        );
        return null;
      }
    };
    const thread = new ThreadRelay({
      threadId,
      clock: this.#clock,
      epoch: this.epoch,
      history: toHistory(read()),
      persist: (history) =>
        this.#files.writeAgui(threadId, {
          messages: history.messages,
          runs: history.runs,
          ...(history.migratedFrom != null && {
            migratedFrom: history.migratedFrom,
          }),
        }),
      remove: () => this.#files.remove(threadId),
      reload: () => {
        const file = read();
        return file == null ? null : toHistory(file);
      },
      onRunForgotten: (runId) => {
        if (this.#runOwners.get(runId) === threadId)
          this.#runOwners.delete(runId);
      },
      onRunFinished: (info) => this.#publishRunFinished(threadId, info),
      onPendingChanged: (pending) => this.#setAttention(threadId, pending),
      log: this.#log,
    });
    this.#threads.set(threadId, thread);
    this.#evictIdle();
    return thread;
  }

  /** Threads nobody watches, with no run and no runtime, beyond the budget. */
  #evictIdle(): void {
    for (const thread of this.#threads.values()) thread.sweep();
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
    for (const [runId, owner] of this.#runOwners)
      if (owner === threadId) this.#runOwners.delete(runId);
  }

  /** Removes `pending`'s reservation, and the thread's map once it is empty. */
  #release(threadId: string, runId: string, pending: Waiter): void {
    const waiting = this.#waiting.get(threadId);
    if (waiting?.get(runId) !== pending) return;
    waiting.delete(runId);
    if (waiting.size === 0) this.#waiting.delete(threadId);
  }

  #waitingFor(threadId: string): Map<string, Waiter> {
    let map = this.#waiting.get(threadId);
    if (map == null) {
      map = new Map();
      this.#waiting.set(threadId, map);
    }
    return map;
  }

  /**
   * A repeated run id's answer, or null for a new one. Synchronous up to the
   * answer: nothing can reserve the run id between this check and the
   * caller's reservation.
   */
  #repeatOf(
    threadId: string,
    runId: string
  ): Promise<AiSendAck> | AiSendAck | null {
    const recorded = this.#acks.get(runKey(threadId, runId));
    if (recorded != null) return this.#answer(runId, recorded, true);
    const inflight = this.#waiting.get(threadId)?.get(runId);
    if (inflight != null)
      return inflight.promise.then((ack) => this.#answer(runId, ack, true));
    // A run main saw start without seeing its ack (an ack line lost to a
    // respawn): it is not new either.
    if (this.#startedRuns.has(runKey(threadId, runId)))
      return this.#answer(runId, { status: "started" }, true);
    return null;
  }

  #answer(runId: string, ack: AckRecord, repeat: boolean): AiSendAck {
    if (ack.status === "unknown") return { runId, status: "duplicate" };
    const extra = {
      ...(ack.reason != null && { reason: ack.reason }),
      ...(ack.entryId != null && { entryId: ack.entryId }),
    };
    return repeat
      ? { runId, status: "duplicate", original: ack.status, ...extra }
      : { runId, status: ack.status, ...extra };
  }

  #settleAck(threadId: string, value: unknown): void {
    if (!isRecord(value) || typeof value.runId !== "string") return;
    const runId = value.runId;
    const key = runKey(threadId, runId);
    const status = value.status;
    const first =
      status === "queued" || status === "rejected" || status === "started"
        ? ({
            status,
            ...(typeof value.reason === "string" &&
              REASONS.has(value.reason) && {
                reason: value.reason as AiSendAck["reason"],
              }),
            ...(typeof value.entryId === "string" && {
              entryId: value.entryId,
            }),
          } satisfies AckRecord)
        : null;
    // The agent's own in-incarnation duplicate: the first answer is main's
    // record, if it has one; without one, the original is not guessed.
    const ack: AckRecord = first ??
      this.#acks.get(key) ?? { status: "unknown" };

    // `thread_mismatch` means main built a bad envelope: never recorded, so
    // a corrected retry of the run id is not answered `duplicate`.
    if (
      first != null &&
      !(status === "rejected" && value.reason === "thread_mismatch") &&
      !this.#acks.has(key)
    ) {
      this.#acks.set(key, first);
      trim(this.#acks, ACKS_KEPT);
      if (first.status === "started" && !this.#startedRuns.has(key)) {
        let awaiting = this.#awaitingStart.get(threadId);
        if (awaiting == null) {
          awaiting = new Set();
          this.#awaitingStart.set(threadId, awaiting);
        }
        awaiting.add(runId);
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

  /**
   * Waits for an agui runtime for the thread, starting one if none runs.
   * One attempt at a time per thread: two first sends start it once.
   */
  async #ensureAguiRuntime(threadId: string): Promise<void> {
    const previous = this.#starting.get(threadId);
    const attempt = (previous ?? Promise.resolve()).then(() =>
      this.#ensureOnce(threadId)
    );
    const settled = attempt.catch(() => undefined);
    this.#starting.set(threadId, settled);
    try {
      await attempt;
    } finally {
      if (this.#starting.get(threadId) === settled)
        this.#starting.delete(threadId);
    }
  }

  async #ensureOnce(threadId: string): Promise<void> {
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
    if (this.#host.send(threadId, command) == null)
      throw unavailable("The agent is not accepting input", 1_000);
  }

  /**
   * Whether a queue edit goes to the agent. An incarnation that is not the
   * live one names entries of a process that is gone: answered on the
   * stream (`queue.command_rejected`) and not sent. Everything else is the
   * agent's to check, atomically, by entry id (spec 02 §14.6).
   */
  #queueTarget(
    threadId: string,
    incarnation: string,
    entryId: string,
    command: "update" | "remove"
  ): boolean {
    this.#requireAgui(threadId);
    const thread = this.#thread(threadId);
    if (thread.incarnation != null && thread.incarnation !== incarnation) {
      thread.rejectQueueCommand(entryId, command, "incarnation");
      return false;
    }
    return true;
  }
}
