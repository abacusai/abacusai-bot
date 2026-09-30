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
import { parseModeStrict } from "../permissions.js";
import type { DesktopCommand, DesktopEvent } from "../protocol.js";
import { AbacusBotSession, approvalTimeoutMs } from "../session.js";
import type { CompatWriter } from "./channel.js";
import { AguiEmitter } from "./emit.js";
import { custom, serialize } from "./event.js";
import { serverRunId } from "./ids.js";
import { decisionKind, validateResponse } from "./permissions.js";
import { HostCore, isPrompt, type TurnHooks } from "./queue.js";
import { RunController, type TurnToken } from "./runs.js";
import { HostSink } from "./sink.js";
import type {
  AgentCommand,
  AguiControlCommand,
  AguiEvent,
  RunAckReason,
  RunInput,
} from "./wire.js";

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
  /** Synchronous stdout write for last words; defaults to fs.writeSync(1). */
  writeStdoutSync?: (text: string) => void;
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
  emitInternal: (event: import("../protocol.js").InternalAgentEvent) => void;
}

/** The newest user message of a RunAgentInput, as text. */
function newestUserMessage(
  input: RunInput
): { id: string | undefined; text: string } | undefined {
  const messages = Array.isArray(input.messages) ? input.messages : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      id?: unknown;
      role?: unknown;
      content?: unknown;
    };

    if (message?.role !== "user") continue;

    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                part != null &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "text"
                  ? String((part as { text?: unknown }).text ?? "")
                  : ""
              )
              .join("")
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
  /** Run ids already answered with an ack, duplicates included. */
  private readonly ackedRunIds = new Set<string>();
  /** The newest user message this incarnation prompted, and the run that did. */
  private lastPrompt: { messageId: string; runId: string } | undefined;
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
      model: () => this.emitter.model(),
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
      this.hooks()
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

    this.runs.emergencyClose(code, (event) => lastWords(serialize(event)));
    this.sink.close();
  }

  /**
   * The fd-3 writer failed after the handshake: main's taps stopped hearing
   * us. Never silent (§2.4): say so on stdout, fail the open run, exit 75.
   */
  compatLost(error: Error): void {
    if (this.exiting) return;
    this.exiting = true;
    this.sink.writeAgui(custom("wire.compat_lost", { error: error.message }));
    this.runs.emergencyClose("compat_lost", (event) =>
      this.sink.writeAgui(event)
    );
    this.sink.close();
    this.log(`[abacusai-bot-agent] compat channel lost: ${error.message}\n`);
    (this.options.exit ?? ((code) => process.exit(code)))(75);
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

    if (this.ackedRunIds.has(runId) || this.runs.hasSeen(runId)) {
      this.ack(runId, "duplicate");

      return;
    }
    this.ackedRunIds.add(runId);

    if (Array.isArray(input.resume) && input.resume.length > 0) {
      this.ack(runId, "rejected", { reason: "resume_unsupported" });

      return;
    }

    const newest = newestUserMessage(input);
    const text = newest?.text;

    if (!isPrompt(text)) {
      this.ack(runId, "rejected", { reason: "empty" });

      return;
    }

    const forwarded = input.forwardedProps ?? {};

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
    this.runs.open(token, runId, { serverInitiated: false, input });
    for (const event of this.emitter.userInput(runId, text, {
      dequeued: false,
      ...(newest?.id != null ? { messageId: newest.id } : {}),
    })) {
      this.write(event);
    }
    if (newest?.id != null) this.lastPrompt = { messageId: newest.id, runId };

    const stillAdmitted = (): boolean =>
      gen === this.admissionGen &&
      !this.runs.isCancelling(token) &&
      this.core.turn === turn &&
      this.runs.openRunId() === runId;

    // Preparation: the same paths set_mode and set_model take.
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

    if (!stillAdmitted()) {
      // Stopped or reset while preparing: that already closed the run
      // cancelled; the prompt is never sent.
      if (gen === this.admissionGen) this.core.preparing = false;

      return;
    }

    this.core.preparing = false;
    await this.core.runHeld(text, "run", { token });
  }

  private async onCancel(
    command: Extract<AguiControlCommand, { type: "cancel" }>
  ): Promise<void> {
    if (command.runId != null && command.runId !== this.runs.openRunId()) {
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

    // The same two calls as the legacy permission_response.
    this.core.session.respondPermission(permissionId, command.decision);
    this.core.awaitingPermission = false;
    await this.core.releaseParked();
    for (const event of this.emitter.resolved(
      permissionId,
      decisionKind(command.decision),
      "respond"
    )) {
      this.write(event);
    }
  }

  // ------------------------------------------------------------------- hooks

  private hooks(): TurnHooks {
    return {
      beginTurn: (_source, text, { dequeued, echoed }) => {
        const token = this.runs.mint();
        const runId = serverRunId();

        // Never over an open run: the previous settle precedes this, and if
        // it somehow did not, the old run is closed rather than the turn lost.
        this.runs.settleOpen();
        this.runs.open(token, runId, { serverInitiated: true });
        if (!echoed) {
          for (const event of this.emitter.userInput(runId, text, {
            dequeued,
          })) {
            this.write(event);
          }
        }

        return token;
      },
      sending: (token: TurnToken | undefined) => {
        this.runs.setCurrent(token ?? null);
      },
      settle: (token) => {
        this.runs.settle(token);
      },
      beforeAbort: (kind) => {
        this.emitter.setClearReason(kind === "stop" ? "stopped" : "reset");
        this.runs.markCancelling(this.runs.openToken());
        this.admissionGen += 1;
      },
      afterAbort: () => {
        const open = this.runs.openToken();

        if (open != null && this.runs.isCancelling(open))
          this.runs.settleOpen();
        this.emitter.setClearReason("expired");
      },
      legacyPermissionAnswered: (permissionId, decision) => {
        for (const event of this.emitter.resolved(
          permissionId,
          decisionKind(decision as never),
          "legacy_response"
        )) {
          this.write(event);
        }
      },
    };
  }
}
