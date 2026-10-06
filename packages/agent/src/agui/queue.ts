/**
 * The host's queue and turn logic, extracted verbatim from the NDJSON host so
 * both wires drive the same session through the same code (spec §6.1).
 *
 * Every legacy command keeps its handler and its exact emit sequence: the
 * NDJSON output is byte-identical by construction, and the goldens prove it.
 * What is new is only observable through `TurnHooks`, which the NDJSON host
 * leaves empty: which token owns each `session.send`, and the single
 * synchronous admission guard (`busy`, `preparing`) every turn starter uses.
 */
import * as readline from "node:readline";
import type { Readable } from "node:stream";

import type { BotSession } from "../bot/bot-session.js";
import { tagEvent } from "../event-meta.js";
import {
  AgentStatus,
  type DesktopCommand,
  type DesktopEvent,
  type PermissionDecision,
  type QueueEntry,
  type UserTextTags,
} from "../protocol.js";
import { shutdownRuntime } from "../sandbox/index.js";
import type { AbacusBotSession } from "../session.js";
import type { TurnToken } from "./runs.js";

export type HostSession = AbacusBotSession | BotSession;

/** Who started a turn. */
export type TurnSource =
  | "run"
  | "send"
  | "enqueue"
  | "dequeue"
  | "drain"
  | "after_stop";

/** What the AG-UI side learns about turns; all optional, all no-ops under ndjson. */
export interface TurnHooks {
  /**
   * A host-started send is about to go out (legacy send/enqueue, dequeue,
   * drains, runAfterStop). Returns the token that owns it.
   */
  beginTurn?(
    source: TurnSource,
    text: string,
    options: { dequeued: boolean; echoed: boolean; userText?: UserTextTags }
  ): TurnToken | undefined;
  /** The send owned by `token` is in flight. */
  sending?(token: TurnToken | undefined): void;
  /**
   * The send owned by `token` returned. Only this token's own bookkeeping is
   * released: an aborted send can resolve after a newer one started.
   */
  sent?(token: TurnToken | undefined): void;
  /**
   * The send owned by `token` threw. Returns true when the failure was
   * recorded as that token's own run terminal, so the thrown-handler error
   * line adds nothing more on AG-UI (spec §2.1).
   */
  failed?(token: TurnToken | undefined, error: unknown): boolean;
  /** The first owner-valid settle closes the token's run. */
  settle?(token: TurnToken | undefined): void;
  /** Synchronously, before a stop or reset is awaited. */
  beforeAbort?(kind: "stop" | "reset"): void;
  /** After the stop/reset landed, before the host says idle. */
  afterAbort?(kind: "stop" | "reset"): void;
  /** A legacy `permission_response` released a waiter. */
  legacyPermissionAnswered?(
    permissionId: string,
    decision: PermissionDecision
  ): void;
}

export interface HostIo {
  stdin: Readable;
  /** Everything the host writes goes through its sink; this is for EOF handling. */
}

/** A promptable message: text, and not only whitespace. */
export function isPrompt(message: unknown): message is string {
  return typeof message === "string" && message.trim().length > 0;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HostCore {
  /**
   * Messages sent while a turn was in flight, oldest first. Each is steered
   * into the turn on arrival and stays here until pi reports it landed, so
   * the desktop can show it as "on its way" and let the user edit it. One
   * that arrives during a permission prompt waits (a steer then could read
   * as the answer) and is steered once the prompt is answered. Whatever is
   * left when the turn ends runs as the next turn.
   */
  readonly queue: QueueEntry[] = [];
  private queueIds = 0;
  /** True between a permission prompt going up and the user answering it. */
  awaitingPermission = false;
  /**
   * True while a stop is landing. The desktop shows idle the instant Stop is
   * pressed, so a message sent in that window arrives while `busy` is still
   * true; it must run as the next turn, once, not sit in the queue.
   */
  stopping = false;
  /**
   * True while an admitted `run` applies its forwardedProps, before its
   * prompt exists: input then waits for the turn, like during a stop.
   */
  preparing = false;
  /** True while a reset is landing (reserved admission only). */
  resetting = false;
  /** Bumped by every Stop and reset; the newest one owns the release. */
  private aborts = 0;
  /** Errors a turn's own run already reported (see TurnHooks.failed). */
  private readonly attributed = new WeakSet<object>();
  /** Entries the desktop already echoed, so no `user_message_dequeued` for them. */
  private readonly echoed = new Set<string>();
  /** Commands still running, so stdin EOF can wait for them instead of killing them. */
  readonly inFlight = new Set<Promise<void>>();
  busy = false;
  /**
   * Bumped by stop and reset. `runTurn` captures it and checks it on the way
   * out: a superseded turn must not drain the queue or clear `busy`, which
   * now belong to the next turn (clearing them would show idle mid-reply).
   */
  turn = 0;

  constructor(
    readonly session: HostSession,
    private readonly emitEvent: (event: DesktopEvent) => void,
    private readonly hooks: TurnHooks = {}
  ) {}

  /** Starts the session; a failure is reported as today and rethrown. */
  async start(): Promise<void> {
    try {
      await this.session.start();
    } catch (error) {
      this.emit({
        type: "event",
        event: tagEvent(
          {
            type: "error",
            error: { message: describe(error), code: "startup_failed" },
          },
          { origin: "startup" }
        ),
      });

      throw error;
    }
  }

  /**
   * The stdin loop. `dispatch` handles one parsed line; the default is the
   * legacy command table.
   */
  async readCommands(
    stdin: Readable,
    dispatch: (command: DesktopCommand) => Promise<void>,
    /** Sees every raw stdin line first (ABACUSAI_BOT_WIRE_RECORD). */
    onLine?: (line: string) => void
  ): Promise<void> {
    const input = readline.createInterface({ input: stdin });

    for await (const line of input) {
      onLine?.(line);
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      let command: DesktopCommand;

      try {
        command = JSON.parse(trimmed) as DesktopCommand;
      } catch {
        process.stderr.write(
          `[abacusai-bot-agent] ignoring malformed command line: ${trimmed.slice(0, 200)}\n`
        );
        // Said out loud: a dropped `send` otherwise shows as a turn that never
        // starts, and the desktop reports it as a ten-minute hang.
        this.emit({
          type: "event",
          event: tagEvent(
            {
              type: "error",
              error: {
                message:
                  "A message could not be read by the agent and was not sent. Try sending it again.",
                code: "malformed_command",
              },
            },
            { origin: "host" }
          ),
        });

        continue;
      }

      // Deliberately not awaited: a turn can park on a permission prompt whose
      // answer is the next stdin line, so awaiting here would deadlock.
      // Ordering is still safe: `runTurn` serializes prompts through `busy`.
      // Nothing about the parsed value is read here: a line such as `null`
      // must fail inside the handler, where the catch below reports it.
      const pending = dispatch(command).catch((error: unknown) => {
        this.emit({
          type: "event",
          event: tagEvent(
            { type: "error", error: { message: describe(error) } },
            this.wasAttributed(error)
              ? { origin: "turn", attributed: true }
              : { origin: "host" }
          ),
        });
      });

      this.inFlight.add(pending);
      void pending.finally(() => this.inFlight.delete(pending));
    }

    // stdin closed. Disposing mid-turn aborts the provider request, and for
    // piped use EOF arrives right after the prompt, so let turns finish first.
    await Promise.allSettled(this.inFlight);
  }

  async shutdown(): Promise<void> {
    this.session.dispose();
    // The sandbox runtime's proxies would keep the process alive past this.
    await shutdownRuntime();
  }

  /** The legacy command table (host.ts:147-327), unchanged. */
  async handle(command: DesktopCommand): Promise<void> {
    switch (command.type) {
      case "send":
        // A missing message crashes inside pi with an unhelpful error and an
        // empty one spends a provider call on nothing.
        if (!isPrompt(command.message)) {
          return;
        }

        await this.runTurn(command.message, "send", {
          userText: command.userText,
        });

        return;

      case "stop":
        await this.stop();

        return;

      case "set_mode":
        this.session.setMode(command.mode);

        return;

      case "set_model":
        await this.session.setModel(command.model);

        return;

      case "refresh_providers":
        await this.session.refreshProviders();

        return;

      case "permission_response": {
        const released = this.session.hasPendingPermission(
          command.permissionId
        );

        this.session.respondPermission(command.permissionId, command.decision);
        // The prompt is answered; messages that waited behind it can go.
        this.awaitingPermission = false;
        if (released) {
          this.hooks.legacyPermissionAnswered?.(
            command.permissionId,
            command.decision
          );
        }
        await this.releaseParked();

        return;
      }

      case "reset_conversation": {
        this.queue.length = 0;
        this.echoed.clear();
        this.emitQueue();
        // Same supersede as `stop`: a turn still unwinding from the old
        // conversation must not drain into the new one.
        this.turn += 1;
        const reserved = this.reserveAbort();

        if (reserved != null) this.resetting = true;
        this.hooks.beforeAbort?.("reset");
        try {
          await this.session.resetConversation();
        } catch (error) {
          // Reserved admission is never held past a failed abort.
          if (reserved != null) this.releaseAbort(reserved);

          throw error;
        }
        // After the await, like `stop`: the reset aborts the in-flight turn.
        const owns = this.releaseAbort(reserved);

        this.hooks.afterAbort?.("reset");
        // Reserved: what arrived while the reset landed runs now, in the new
        // conversation.
        if (reserved != null && owns) await this.runAfterStop();

        return;
      }

      case "enqueue":
        // Same as a send: a message that arrives mid-turn steers the turn.
        if (!isPrompt(command.message)) {
          return;
        }

        await this.runTurn(command.message, "enqueue", {
          userText: command.userText,
        });

        return;

      case "dequeue": {
        // Mid-turn, shifting here and letting runTurn re-push would move the
        // entry to the back; the running turn's drain loop delivers it in order.
        if (this.busy) {
          return;
        }

        const next = this.queue.shift() ?? null;

        this.emitQueue(next?.message ?? null);

        if (next) {
          await this.runTurn(next.message, "dequeue", { dequeued: true });
        }

        return;
      }

      case "get_queue":
        this.emitQueue();

        return;

      case "clear_queue":
        this.queue.length = 0;
        this.session.dropSteers();
        this.emitQueue();

        return;

      case "remove_from_queue":
        if (command.index >= 0 && command.index < this.queue.length) {
          this.queue.splice(command.index, 1);
          await this.resyncSteers();
        }

        this.emitQueue();

        return;

      case "update_queue_item": {
        const entry = this.queue[command.index];

        if (entry != null && isPrompt(command.message)) {
          entry.message = command.message;
          await this.resyncSteers();
        }

        this.emitQueue();

        return;
      }

      case "switch_conversation":
      case "list_skills":
        // Skills are published at startup and on reload; a conversation switch
        // is handled by the app spawning a fresh host for that conversation.
        return;

      case "mcp_list_servers":
        this.session.emitMcpServers();

        return;

      case "mcp_refresh":
        await this.session.refreshMcp();

        return;

      case "mcp_restart_server":
        // Reconnected as a set: an HTTP server has no process to bounce alone.
        await this.session.refreshMcp();

        return;

      case "mcp_get_server_logs":
        this.emit({
          type: "mcp_server_logs",
          serverId: command.serverId,
          entries: [],
        });

        return;

      case "host_service_response":
        this.session.settleHostService(
          command.requestId,
          command.ok,
          command.result,
          command.error
        );

        return;

      default:
        return;
    }
  }

  /** The legacy Stop (host.ts:160-182), with the abort hooks around it. */
  async stop(): Promise<void> {
    // Stop ends the reply in flight, not what the user asked next. pi
    // drops its steering queue on abort, so anything still on its way
    // becomes the turn after; only runAfterStop starts it.
    for (const entry of this.queue) entry.waitingFor = "turn";
    this.emitQueue();
    this.turn += 1;
    this.stopping = true;
    const reserved = this.reserveAbort();

    this.hooks.beforeAbort?.("stop");
    try {
      await this.session.stop();
    } catch (error) {
      // Reserved admission is never held past a failed abort.
      if (reserved != null) this.releaseAbort(reserved);

      throw error;
    } finally {
      if (reserved == null) this.stopping = false;
    }
    // Only after the abort has fully landed: a send racing the stop must
    // wait rather than run against a session that is still aborting.
    const owns = this.releaseAbort(reserved);

    this.hooks.afterAbort?.("stop");
    this.emit({
      type: "event",
      event: { type: "status_changed", status: AgentStatus.Idle },
    });
    if (owns) await this.runAfterStop();
  }

  /**
   * Reserved admission (`reserveDuringAbort`): `busy` is held from here until
   * the abort lands, so every turn starter queues behind it. Returns this
   * abort's sequence number, or null under the legacy (ndjson) behaviour.
   */
  private reserveAbort(): number | null {
    this.busy = true;

    return ++this.aborts;
  }

  /**
   * Releases admission after an abort landed: always under ndjson (exactly
   * the legacy assignments), and under reservation only for the newest Stop
   * or reset, so an older one finishing late never frees a guard a newer
   * one, or the turn it started, now holds. Returns whether it released.
   */
  private releaseAbort(reserved: number | null): boolean {
    if (reserved != null && reserved !== this.aborts) return false;
    this.stopping = false;
    this.resetting = false;
    this.busy = false;
    this.preparing = false;

    return true;
  }

  /** Whether `error` was already reported as its own run's terminal. */
  wasAttributed(error: unknown): boolean {
    return (
      error !== null && typeof error === "object" && this.attributed.has(error)
    );
  }

  /** Marks `error` as reported by its own run's terminal (see TurnHooks.failed). */
  markAttributed(error: unknown): void {
    if (error !== null && typeof error === "object") this.attributed.add(error);
  }

  /**
   * Run one turn, then drain what the steer could not deliver: a message
   * parked behind an unanswered prompt, or one sent as the turn ended.
   */
  async runTurn(
    message: string,
    source: TurnSource,
    options: {
      dequeued?: boolean;
      echoed?: boolean;
      userText?: UserTextTags;
    } = {}
  ): Promise<void> {
    if (this.busy) {
      await this.admit(message, options.userText);

      return;
    }

    this.busy = true;

    await this.runHeld(message, source, options);
  }

  /**
   * The body of `runTurn` with `busy` already held: an admitted `run` enters
   * here with its own token after its preparation.
   */
  async runHeld(
    message: string,
    source: TurnSource,
    options: {
      dequeued?: boolean;
      echoed?: boolean;
      token?: TurnToken;
      userText?: UserTextTags;
    } = {}
  ): Promise<void> {
    const turn = this.turn;

    try {
      await this.sendOwned(
        message,
        options.token ??
          this.hooks.beginTurn?.(source, message, {
            dequeued: options.dequeued === true,
            echoed: options.echoed === true,
            userText: options.userText,
          })
      );

      // pi may still hold the leftovers as steers and would inject them on
      // top of the send below, so its copy goes first.
      if (this.turn === turn && this.queue.length > 0) {
        this.session.dropSteers();
      }

      while (this.turn === turn && this.queue.length > 0) {
        const next = this.queue.shift();

        if (next === undefined) {
          break;
        }

        this.emitQueue(next.message);
        const echoed = this.echoed.delete(next.id);
        if (!echoed) {
          this.emit({
            type: "event",
            event: { type: "user_message_dequeued", content: next.message },
          });
        }
        await this.sendOwned(
          next.message,
          this.hooks.beginTurn?.("drain", next.message, {
            dequeued: true,
            echoed,
            userText: next.userText,
          })
        );
      }
    } finally {
      if (this.turn === turn) {
        this.busy = false;
        this.emit({
          type: "event",
          event: { type: "status_changed", status: AgentStatus.Idle },
        });
      }
    }
  }

  /** One `session.send`, owned by `token` from start to settle. */
  private async sendOwned(
    message: string,
    token: TurnToken | undefined
  ): Promise<void> {
    this.hooks.sending?.(token);
    try {
      await this.session.send(message, {
        settled: () => this.hooks.settle?.(token),
      });
    } catch (error) {
      // Recorded against this token's own run before the settle below
      // closes it, so the run ends in RUN_ERROR and never in a success
      // followed by a stray error (spec §2.1).
      if (this.hooks.failed?.(token, error) === true) {
        this.markAttributed(error);
      }

      throw error;
    } finally {
      this.hooks.settle?.(token);
      this.hooks.sent?.(token);
    }
  }

  /**
   * A message sent mid-turn: steer it now, park it behind the prompt, or,
   * while a stop is landing (or a run is still preparing), hold it for the
   * turn after.
   */
  async admit(message: string, userText?: UserTextTags): Promise<QueueEntry> {
    const { entry, steered } = this.admitNow(message, userText);

    await steered;

    return entry;
  }

  /** `admit`'s synchronous part, so a caller can acknowledge before the steer lands. */
  admitNow(
    message: string,
    userText?: UserTextTags
  ): { entry: QueueEntry; steered: Promise<void> } {
    const entry: QueueEntry = {
      id: `q-${++this.queueIds}`,
      ...(userText != null && { userText }),
      message,
      waitingFor:
        this.stopping || this.preparing || this.resetting
          ? "turn"
          : this.awaitingPermission
            ? "permission"
            : "step",
    };

    // The desktop already drew the bubble (it showed idle); don't draw two.
    if (this.stopping) this.echoed.add(entry.id);

    this.queue.push(entry);
    this.emitQueue();

    return {
      entry,
      steered:
        entry.waitingFor === "step"
          ? this.session.steer(message)
          : Promise.resolve(),
    };
  }

  /** Whatever arrived while the stop was landing runs now, as its own turn. */
  async runAfterStop(): Promise<void> {
    const next = this.queue.shift();

    if (next === undefined) return;

    this.emitQueue(next.message);
    // Sent mid-turn it needs its bubble now; sent mid-stop it already has one.
    const echoed = this.echoed.delete(next.id);
    if (!echoed) {
      this.emit({
        type: "event",
        event: { type: "user_message_dequeued", content: next.message },
      });
    }
    await this.runTurn(next.message, "after_stop", {
      dequeued: true,
      echoed,
      userText: next.userText,
    });
  }

  /** The prompt was answered: everything parked behind it is steered, in order. */
  async releaseParked(): Promise<void> {
    for (const entry of this.queue) {
      if (entry.waitingFor !== "permission") continue;
      entry.waitingFor = "step";
      await this.session.steer(entry.message);
    }

    this.emitQueue();
  }

  /**
   * pi's steering queue is text in, text out, with no ids, so an edit or a
   * removal rebuilds it from what remains here, in order.
   */
  private async resyncSteers(): Promise<void> {
    this.session.dropSteers();

    for (const entry of this.queue) {
      if (entry.waitingFor !== "step") continue;
      await this.session.steer(entry.message);
    }
  }

  /**
   * The queue follows the turn: a landed steer leaves it, and a permission
   * prompt parks whatever arrives until it is answered.
   */
  onSessionEvent(event: DesktopEvent): void {
    if (event.type === "permission_needed") {
      this.awaitingPermission = true;
    } else if (event.type === "event") {
      if (event.event.type === "status_changed") {
        this.awaitingPermission =
          event.event.status === AgentStatus.WaitingForToolPermission;
      } else if (event.event.type === "user_message_steered") {
        const content = event.event.content;
        const index = this.queue.findIndex(
          (entry) => entry.waitingFor === "step" && entry.message === content
        );

        if (index !== -1) {
          const [entry] = this.queue.splice(index, 1);
          if (entry?.userText != null) event.event.userText = entry.userText;
        }

        this.emit(event);
        this.emitQueue();

        return;
      }
    }

    this.emit(event);
  }

  emitQueue(dequeued: string | null = null): void {
    this.emit({ type: "queue_updated", messages: [...this.queue], dequeued });
  }

  emit(event: DesktopEvent): void {
    this.emitEvent(event);
  }
}
