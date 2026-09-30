/**
 * `AguiHost`: the `--wire agui` process (spec §2, §3). stdout carries AG-UI
 * (line 1, `wire.hello`, is written by main.ts before this host exists); the
 * compatibility stream carries today's NDJSON byte for byte. stdin accepts
 * every legacy command, handled by the shared HostCore exactly as the NDJSON
 * host handles it, plus `run`, `cancel` and `permission.respond`.
 */
import { writeSync } from "node:fs";
import type { Readable } from "node:stream";

import { isBotSession } from "../bot/bot-config.js";
import { BotSession } from "../bot/bot-session.js";
import { tagEvent } from "../event-meta.js";
import { parseModeStrict } from "../permissions.js";
import type { DesktopCommand, DesktopEvent } from "../protocol.js";
import { AbacusBotSession, approvalTimeoutMs } from "../session.js";
import { BoundedSet, RUN_IDS_KEPT } from "./bounded.js";
import type { CompatWriter } from "./channel.js";
import { AguiEmitter } from "./emit.js";
import { custom, serialize } from "./event.js";
import { serverRunId } from "./ids.js";
import { decisionKind, validateResponse } from "./permissions.js";
import { describe, HostCore, isPrompt, type TurnHooks } from "./queue.js";
import { RunController, type TurnToken } from "./runs.js";
import { HostSink } from "./sink.js";
import type {
  AgentCommand,
  AguiControlCommand,
  AguiEvent,
  RunAckReason,
  RunInput,
} from "./wire.js";

/** How long compat loss waits for stdout to drain before exiting anyway. */
export const COMPAT_LOSS_FLUSH_MS = 5_000;

export interface AguiHostOptions {
  cwd: string;
  model?: string;
  mode?: string;
  threadId: string;
  incarnation: string;
  compat: CompatWriter;
  /** Defaults to process.stdin. */
  stdin?: Readable;
  /** Defaults to process.stdout.write. */
  writeStdout?: (text: string) => void;
  /**
   * Writes the process's final stdout text and calls `done` once it, and
   * everything queued before it, has been handed to the OS. Defaults to
   * process.stdout.write with a callback.
   */
  writeStdoutLast?: (text: string, done: () => void) => void;
  /** Synchronous stdout write for last words; defaults to fs.writeSync(1). */
  writeStdoutSync?: (text: string) => void;
  /**
   * Bytes stdout still holds in-process; defaults to
   * process.stdout.writableLength. A synchronous last write is only safe at 0.
   */
  pendingStdout?: () => number;
  /** Defaults to process.exit. */
  exit?: (code: number) => void;
  /** Defaults to stderr. */
  log?: (line: string) => void;
  /** Tests: build the session themselves. */
  session?: (init: SessionInit) => AbacusBotSession | BotSession;
}

export interface SessionInit {
  cwd: string;
  model?: string;
  mode?: string;
  emit: (event: DesktopEvent) => void;
  emitInternal: (
    event: import("../internal-events.js").InternalAgentEvent
  ) => void;
}

/** The text of one part: AG-UI `{type:"text", text}` or TanStack `{type:"text", content}`. */
function partText(part: unknown): string {
  if (part == null || typeof part !== "object") return "";

  const { type, text, content } = part as {
    type?: unknown;
    text?: unknown;
    content?: unknown;
  };

  if (type !== "text") return "";
  if (typeof text === "string") return text;

  return typeof content === "string" ? content : "";
}

/**
 * The newest user message of a RunAgentInput, as text. Accepts the three
 * shapes a SubscribeConnectionAdapter can be handed: AG-UI messages
 * (`content` string or `{type:"text", text}` parts), TanStack ModelMessages
 * (`content` string or `{type:"text", content}` parts) and UIMessages
 * (`parts[]` of `{type:"text", content}`). Non-text parts (images) carry no
 * prompt text in this slice.
 */
export function newestUserMessage(
  input: RunInput
): { id: string | undefined; text: string } | undefined {
  const messages: unknown[] = Array.isArray(input.messages)
    ? input.messages
    : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { id?: unknown; role?: unknown; content?: unknown; parts?: unknown }
      | null
      | undefined;

    if (message?.role !== "user") continue;

    const { content, parts } = message;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map(partText).join("")
          : Array.isArray(parts)
            ? parts.map(partText).join("")
            : "";

    return {
      id: typeof message.id === "string" ? message.id : undefined,
      text,
    };
  }

  return undefined;
}

export class AguiHost {
  readonly runs: RunController;
  readonly emitter: AguiEmitter;
  private readonly sink: HostSink;
  private readonly core: HostCore;
  private readonly options: AguiHostOptions;
  private readonly log: (line: string) => void;
  /** Bumped by every stop and reset: a preparation that sees a new value never prompts. */
  private admissionGen = 0;
  /**
   * Run ids already answered with an ack, duplicates included: the newest
   * `RUN_IDS_KEPT`, which covers every repeat main can still forward
   * (bounded.ts).
   */
  private readonly ackedRunIds = new BoundedSet<string>(RUN_IDS_KEPT);
  /** The newest user message this incarnation prompted, and the run that did. */
  private lastPrompt: { messageId: string; runId: string } | undefined;
  /**
   * Client user-message ids already echoed on stdout this incarnation. A
   * retry reuses its message id; echoing the text again would append it to
   * the message a continuous StreamProcessor (main's transcript, a second
   * window) already holds. Bounded like `ackedRunIds`: one id per run.
   */
  private readonly echoedUserIds = new BoundedSet<string>(RUN_IDS_KEPT);
  /** A reset is landing: its cancelled terminal precedes the new `session.ready`. */
  private resetInFlight = false;
  private exiting = false;

  constructor(options: AguiHostOptions) {
    this.options = options;
    this.log =
      options.log ?? ((line: string) => void process.stderr.write(line));
    const writeStdout =
      options.writeStdout ??
      ((text: string) => void process.stdout.write(text));

    this.sink = new HostSink(options.compat);
    this.runs = new RunController({
      threadId: options.threadId,
      write: (event) => this.sink.writeAgui(event),
      closeOpenParts: () => this.emitter.closeOpenParts(),
      errorAnchor: (runId) => this.emitter.errorAnchor(runId),
      model: () => this.emitter.model(),
      onOpen: () => this.emitter.runOpened(),
    });
    this.emitter = new AguiEmitter({
      threadId: options.threadId,
      incarnation: options.incarnation,
      runs: this.runs,
      approvalTimeoutMs,
      now: () => Date.now(),
      log: this.log,
    });
    this.sink.attach({
      emitter: this.emitter,
      runs: this.runs,
      write: writeStdout,
      beforeLegacy: (event) => {
        // A reset's cancelled terminal comes before the replacement
        // session's ready and snapshot (§3.8), not after them.
        if (event.type === "ready" && this.resetInFlight) {
          this.runs.settleOpen();
        }
      },
    });

    const init: SessionInit = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      emit: (event) => this.core.onSessionEvent(event),
      emitInternal: (event) => this.sink.internal(event),
    };
    const session =
      options.session?.(init) ??
      (isBotSession() ? new BotSession(init) : new AbacusBotSession(init));

    this.core = new HostCore(
      session,
      (event) => this.sink.emit(event),
      this.hooks(),
      { reserveDuringAbort: true }
    );
  }

  async run(): Promise<void> {
    await this.core.start();
    await this.core.readCommands(
      this.options.stdin ?? process.stdin,
      (command) => this.dispatch(command as AgentCommand)
    );
    // stdin closed and every command settled: a run still open never got its
    // terminal from the session, so it gets one now (§3.8).
    this.runs.emergencyClose("agent_exit", (event) =>
      this.sink.writeAgui(event)
    );
    await this.core.shutdown();
  }

  /**
   * Last words for an open run as the process goes away: synchronous,
   * idempotent, compat untouched.
   */
  emergencyClose(code: "agent_crashed" | "agent_exit"): void {
    const lastWords =
      this.options.writeStdoutSync ??
      ((text: string) => {
        try {
          writeSync(1, text);
        } catch {
          // stdout is gone; there is no one left to tell.
        }
      });
    const pending =
      this.options.pendingStdout ?? (() => process.stdout.writableLength);

    if (this.runs.isOpen() && pending() > 0) {
      // Earlier lines are still queued in-process (an asynchronous pipe
      // under backpressure). A synchronous write now would land ahead of
      // them, or inside a partly written line, and they die with the
      // process anyway. Main synthesizes the terminal for a dead runtime.
      this.log(
        `[abacusai-bot-agent] ${code}: stdout still holds ${pending()} bytes; the open run's terminal is left to main\n`
      );
      this.sink.close();

      return;
    }

    // The open parts, the error anchor and the terminal go out as one write.
    let last = "";

    this.runs.emergencyClose(code, (event) => {
      last += serialize(event);
    });
    if (last.length > 0) lastWords(last);
    this.sink.close();
  }

  /**
   * The fd-3 writer failed after the handshake: main's taps stopped hearing
   * us. Never silent (§2.4): say so on stdout, fail the open run, exit 75,
   * but only once those lines have left the process.
   */
  compatLost(error: Error): void {
    if (this.exiting) return;
    this.exiting = true;

    // Both last lines go out as one write queued behind everything already
    // written, and the process exits once that write has been handed to the
    // OS: exiting right after an asynchronous (piped) write under
    // backpressure drops it, and main would never learn why.
    let last = serialize(custom("wire.compat_lost", { error: error.message }));

    this.runs.emergencyClose("compat_lost", (event) => {
      last += serialize(event);
    });
    this.sink.close();
    this.log(`[abacusai-bot-agent] compat channel lost: ${error.message}\n`);

    const exit = this.options.exit ?? ((code) => process.exit(code));
    const writeLast =
      this.options.writeStdoutLast ??
      ((text: string, done: () => void) => {
        process.stdout.write(text, () => done());
      });
    let exited = false;
    const exitOnce = (): void => {
      if (exited) return;
      exited = true;
      exit(75);
    };
    // A stdout nobody reads would hold the exit forever: a reader that
    // leaves a pipe full this long is gone or wedged.
    const fallback = setTimeout(exitOnce, COMPAT_LOSS_FLUSH_MS);

    fallback.unref();
    writeLast(last, () => {
      clearTimeout(fallback);
      exitOnce();
    });
  }

  // ---------------------------------------------------------------- commands

  private async dispatch(command: AgentCommand): Promise<void> {
    switch (command.type) {
      case "run":
        await this.onRun(command.input);

        return;

      case "cancel":
        await this.onCancel(command);

        return;

      case "permission.respond":
        await this.onRespond(command);

        return;

      case "queue.update":
      case "queue.remove":
        await this.onQueueEdit(command);

        return;

      default:
        await this.core.handle(command as DesktopCommand);
    }
  }

  private write(event: AguiEvent): void {
    this.sink.writeAgui(event);
  }

  private ack(
    runId: string,
    status: "started" | "queued" | "duplicate" | "rejected",
    extra: {
      entryId?: string;
      waitingFor?: "step" | "permission" | "turn";
      reason?: RunAckReason;
    } = {}
  ): void {
    this.write(custom("run.ack", { runId, status, ...extra }));
  }

  /** The single admission guard for a client `run` (§3.1.1). */
  private async onRun(input: RunInput | undefined): Promise<void> {
    const runId = input?.runId;

    if (input == null || typeof runId !== "string" || runId.length === 0) {
      this.log("[abacusai-bot-agent] ignoring a run with no runId\n");
      this.write(
        custom("agent.error", {
          message: "A run could not be read by the agent.",
          code: "malformed_command",
        })
      );

      return;
    }

    // The envelope first: a run for another thread never reaches the
    // duplicate set, the queue, or the session's mode and model.
    const forwarded: NonNullable<RunInput["forwardedProps"]> =
      input.forwardedProps != null && typeof input.forwardedProps === "object"
        ? input.forwardedProps
        : {};

    if (
      input.threadId !== this.options.threadId ||
      (forwarded.conversationId !== undefined &&
        forwarded.conversationId !== this.options.threadId)
    ) {
      this.log(
        `[abacusai-bot-agent] rejecting run ${runId}: not for thread ${this.options.threadId}\n`
      );
      this.ack(runId, "rejected", { reason: "thread_mismatch" });

      return;
    }

    if (this.ackedRunIds.has(runId) || this.runs.hasSeen(runId)) {
      this.ack(runId, "duplicate");

      return;
    }
    this.ackedRunIds.add(runId);

    // Anything but an absent or empty array is a resume, which this agent
    // does not take (§3.5); a non-array value is not waved through.
    const resume: unknown = input.resume;

    if (
      resume !== undefined &&
      !(Array.isArray(resume) && resume.length === 0)
    ) {
      this.ack(runId, "rejected", { reason: "resume_unsupported" });

      return;
    }

    const newest = newestUserMessage(input);
    const text = newest?.text;

    if (!isPrompt(text)) {
      this.ack(runId, "rejected", { reason: "empty" });

      return;
    }

    if (
      newest?.id != null &&
      this.lastPrompt?.messageId === newest.id &&
      forwarded.intent === "regenerate" &&
      this.runs.outcomeOf(this.lastPrompt.runId) === "success"
    ) {
      this.ack(runId, "rejected", { reason: "regenerate_unsupported" });

      return;
    }

    // Busy (the two-window race): today's send-while-busy, and no run opens.
    if (this.core.busy) {
      const { entry, steered } = this.core.admitNow(text);

      this.ack(runId, "queued", {
        entryId: entry.id,
        waitingFor: entry.waitingFor,
      });
      await steered;

      return;
    }

    // Acquire, synchronously, before any await.
    this.core.busy = true;
    this.core.preparing = true;
    const gen = ++this.admissionGen;
    const turn = this.core.turn;
    const token = this.runs.mint(runId);

    this.ack(runId, "started");
    this.runs.open(token, runId, { serverInitiated: false });
    // A retry reuses its message id, and its text is already on stdout.
    if (newest?.id == null || !this.echoedUserIds.has(newest.id)) {
      for (const event of this.emitter.userInput(runId, text, {
        dequeued: false,
        ...(newest?.id != null ? { messageId: newest.id } : {}),
      })) {
        this.write(event);
      }
      if (newest?.id != null) this.echoedUserIds.add(newest.id);
    }
    if (newest?.id != null) this.lastPrompt = { messageId: newest.id, runId };

    const stillAdmitted = (): boolean =>
      gen === this.admissionGen &&
      !this.runs.isCancelling(token) &&
      this.core.turn === turn &&
      this.runs.openRunId() === runId;
    let prompted = false;

    try {
      // Preparation: the same paths set_mode and set_model take. A failure
      // is non-terminal (§3.2), exactly as a failed `set_model` followed by
      // `send` is today: its error line goes out and the prompt still runs.
      try {
        if (
          typeof forwarded.mode === "string" &&
          parseModeStrict(forwarded.mode) !== this.emitter.agentState().mode
        ) {
          this.core.session.setMode(forwarded.mode);
        }

        if (
          typeof forwarded.model === "string" &&
          forwarded.model.length > 0 &&
          forwarded.model !== this.emitter.model()
        ) {
          await this.core.session.setModel(forwarded.model);
        }
      } catch (error) {
        this.core.emit({
          type: "event",
          event: tagEvent(
            { type: "error", error: { message: describe(error) } },
            { origin: "command" }
          ),
        });
      }

      if (!stillAdmitted()) {
        // Stopped or reset while preparing: that already closed the run
        // cancelled, and released admission; the prompt is never sent.
        return;
      }

      this.core.preparing = false;
      prompted = true;
      await this.core.runHeld(text, "run", { token });
    } catch (error) {
      // Something other than the session's own reporting threw before the
      // prompt: the run is this command's own, so it ends in RUN_ERROR.
      if (
        !prompted &&
        this.runs.recordFailureFor(token, { message: describe(error) })
      ) {
        this.core.markAttributed(error);
      }

      throw error;
    } finally {
      // Never leave admission held by a preparation that did not reach its
      // prompt, unless a Stop or reset took it over (they release it).
      if (!prompted && gen === this.admissionGen) {
        this.core.preparing = false;
        this.runs.settle(token);
        this.core.busy = false;
        await this.core.runAfterStop();
      }
    }
  }

  /**
   * `queue.update` / `queue.remove` (spec 02 §14.6): the incarnation and the
   * entry id are checked, and the entry is found by id and changed, in one
   * synchronous step (the legacy handler mutates before its first await), so
   * a drain in between can never shift the target. The accepted path is
   * today's `update_queue_item` / `remove_from_queue` for that index, compat
   * lines included; a refusal writes nothing to compat.
   */
  private async onQueueEdit(
    command: Extract<
      AguiControlCommand,
      { type: "queue.update" } | { type: "queue.remove" }
    >
  ): Promise<void> {
    const kind = command.type === "queue.update" ? "update" : "remove";
    const index =
      command.incarnation === this.options.incarnation
        ? this.core.queue.findIndex((entry) => entry.id === command.entryId)
        : -1;

    if (index === -1) {
      this.write(
        custom("queue.command_rejected", {
          incarnation: this.options.incarnation,
          entryId: String(command.entryId),
          command: kind,
          reason:
            command.incarnation === this.options.incarnation
              ? "not_found"
              : "incarnation",
        })
      );
      this.write(
        custom("queue.updated", {
          messages: [...this.core.queue],
          dequeued: null,
        })
      );

      return;
    }

    await this.core.handle(
      command.type === "queue.update"
        ? { type: "update_queue_item", index, message: command.message }
        : { type: "remove_from_queue", index }
    );
  }

  private async onCancel(
    command: Extract<AguiControlCommand, { type: "cancel" }>
  ): Promise<void> {
    if (
      command.runId !== undefined &&
      command.runId !== this.runs.openRunId()
    ) {
      this.log(
        `[abacusai-bot-agent] ignoring cancel for ${command.runId}: not the current run\n`
      );

      return;
    }

    await this.core.stop();
  }

  private async onRespond(
    command: Extract<AguiControlCommand, { type: "permission.respond" }>
  ): Promise<void> {
    const reason = validateResponse({
      lineage: command.lineage,
      decision: command.decision,
      threadId: this.options.threadId,
      incarnation: this.options.incarnation,
      pending: this.emitter.pendingPermissions(),
    });
    const permissionId = command.lineage?.permissionId;

    if (
      reason != null ||
      !this.core.session.hasPendingPermission(permissionId)
    ) {
      this.write(
        custom("permission.response_rejected", {
          lineage: command.lineage,
          reason: reason ?? "not_pending",
        })
      );
      this.write(this.emitter.pendingEvent());

      return;
    }

    // The same two calls as the legacy permission_response. The resolution
    // goes out before anything the released waiter or the parked steers
    // cause (the tool's own events, a sibling's new request), as on the
    // legacy path, so the authoritative set never shows an answered card.
    this.core.session.respondPermission(permissionId, command.decision);
    this.core.awaitingPermission = false;
    for (const event of this.emitter.resolved(
      permissionId,
      decisionKind(command.decision),
      "respond"
    )) {
      this.write(event);
    }
    await this.core.releaseParked();
  }

  // ------------------------------------------------------------------- hooks

  private hooks(): TurnHooks {
    return {
      beginTurn: (_source, text, { dequeued }) => {
        const token = this.runs.mint();
        const runId = serverRunId();

        // Never over an open run: the previous settle precedes this, and if
        // it somehow did not, the old run is closed rather than the turn lost.
        this.runs.settleOpen();
        this.runs.open(token, runId, { serverInitiated: true });
        // The run's input always goes out on AG-UI, echoed or not: `echoed`
        // only spares the old renderer a second bubble on compat. On an agui
        // runtime nothing has drawn it (a raced run's optimistic message was
        // removed by its queued terminal), and main's transcript and
        // `hydrate` learn the run's input only from here.
        for (const event of this.emitter.userInput(runId, text, {
          dequeued,
        })) {
          this.write(event);
        }

        return token;
      },
      sending: (token: TurnToken | undefined) => {
        this.runs.setCurrent(token ?? null);
      },
      sent: (token: TurnToken | undefined) => {
        // An aborted send can resolve after runAfterStop started a newer
        // one: only its own token is released, so the newer send's
        // permissions keep their owning turn (§3.5.3).
        if (token != null && this.runs.currentToken()?.seq === token.seq) {
          this.runs.setCurrent(null);
        }
      },
      failed: (token, error) =>
        this.runs.recordFailureFor(token, { message: describe(error) }),
      settle: (token) => {
        this.runs.settle(token);
      },
      beforeAbort: (kind) => {
        this.emitter.setClearReason(kind === "stop" ? "stopped" : "reset");
        this.runs.markCancelling(this.runs.openToken());
        this.admissionGen += 1;
        if (kind === "reset") this.resetInFlight = true;
      },
      afterAbort: (kind) => {
        const open = this.runs.openToken();

        if (open != null && this.runs.isCancelling(open))
          this.runs.settleOpen();
        this.emitter.setClearReason("expired");
        if (kind === "reset") this.resetInFlight = false;
      },
      legacyPermissionAnswered: (permissionId, decision) => {
        for (const event of this.emitter.resolved(
          permissionId,
          decisionKind(decision),
          "legacy_response"
        )) {
          this.write(event);
        }
      },
    };
  }
}
