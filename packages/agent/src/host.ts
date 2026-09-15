/**
 * The NDJSON host: stdin carries `DesktopCommand`, stdout carries `DesktopEvent`,
 * one JSON object per line. One process owns exactly one conversation.
 *
 * stdout is the protocol: a stray `console.log` corrupts a frame, so
 * diagnostics go to stderr. A command must never kill the process: a thrown
 * handler becomes an `error` event and the session stays alive.
 */
import * as readline from "node:readline";

import { isBotSession } from "./bot/bot-config.js";
import { BotSession } from "./bot/bot-session.js";
import {
  AgentStatus,
  type DesktopCommand,
  type DesktopEvent,
  type QueueEntry,
} from "./protocol.js";
import { AbacusBotSession } from "./session.js";

export interface HostOptions {
  cwd: string;
  model?: string;
  mode?: string;
}

export class NdjsonHost {
  private readonly session: AbacusBotSession | BotSession;
  /**
   * Messages sent while a turn was in flight, oldest first. Each is steered
   * into the turn on arrival and stays here until pi reports it landed, so
   * the desktop can show it as "on its way" and let the user edit it. One
   * that arrives during a permission prompt waits (a steer then could read
   * as the answer) and is steered once the prompt is answered. Whatever is
   * left when the turn ends runs as the next turn.
   */
  private readonly queue: QueueEntry[] = [];
  private queueIds = 0;
  /** True between a permission prompt going up and the user answering it. */
  private awaitingPermission = false;
  /**
   * True while a stop is landing. The desktop shows idle the instant Stop is
   * pressed, so a message sent in that window arrives while `busy` is still
   * true; it must run as the next turn, once, not sit in the queue.
   */
  private stopping = false;
  /** Entries the desktop already echoed, so no `user_message_dequeued` for them. */
  private readonly echoed = new Set<string>();
  /** Commands still running, so stdin EOF can wait for them instead of killing them. */
  private readonly inFlight = new Set<Promise<void>>();
  private busy = false;
  /**
   * Bumped by stop and reset. `runTurn` captures it and checks it on the way
   * out: a superseded turn must not drain the queue or clear `busy`, which
   * now belong to the next turn (clearing them would show idle mid-reply).
   */
  private turn = 0;

  constructor(options: HostOptions) {
    const init = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      emit: (event: DesktopEvent) => this.onSessionEvent(event),
    };

    // A bot's chat runs the bot loop; everything else the coding session.
    // Decided by the spawn env so nothing above here knows there are two.
    this.session = isBotSession()
      ? new BotSession(init)
      : new AbacusBotSession(init);
  }

  async run(): Promise<void> {
    try {
      await this.session.start();
    } catch (error) {
      this.emit({
        type: "event",
        event: {
          type: "error",
          error: { message: describe(error), code: "startup_failed" },
        },
      });

      throw error;
    }

    const input = readline.createInterface({ input: process.stdin });

    for await (const line of input) {
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
          event: {
            type: "error",
            error: {
              message:
                "A message could not be read by the agent and was not sent. Try sending it again.",
              code: "malformed_command",
            },
          },
        });

        continue;
      }

      // Deliberately not awaited: a turn can park on a permission prompt whose
      // answer is the next stdin line, so awaiting here would deadlock.
      // Ordering is still safe: `runTurn` serializes prompts through `busy`.
      const pending = this.handle(command).catch((error) => {
        this.emit({
          type: "event",
          event: { type: "error", error: { message: describe(error) } },
        });
      });

      this.inFlight.add(pending);
      void pending.finally(() => this.inFlight.delete(pending));
    }

    // stdin closed. Disposing mid-turn aborts the provider request, and for
    // piped use EOF arrives right after the prompt, so let turns finish first.
    await Promise.allSettled(this.inFlight);

    this.session.dispose();
  }

  private async handle(command: DesktopCommand): Promise<void> {
    switch (command.type) {
      case "send":
        // A missing message crashes inside pi with an unhelpful error and an
        // empty one spends a provider call on nothing.
        if (!isPrompt(command.message)) {
          return;
        }

        await this.runTurn(command.message);

        return;

      case "stop":
        // Stop ends the reply in flight, not what the user asked next. pi
        // drops its steering queue on abort, so anything still on its way
        // becomes the turn after; only runAfterStop starts it.
        for (const entry of this.queue) entry.waitingFor = "turn";
        this.emitQueue();
        this.turn += 1;
        this.stopping = true;
        try {
          await this.session.stop();
        } finally {
          this.stopping = false;
        }
        // Only after the abort has fully landed: a send racing the stop must
        // wait rather than run against a session that is still aborting.
        this.busy = false;
        this.emit({
          type: "event",
          event: { type: "status_changed", status: AgentStatus.Idle },
        });
        await this.runAfterStop();

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

      case "permission_response":
        this.session.respondPermission(command.permissionId, command.decision);
        // The prompt is answered; messages that waited behind it can go.
        this.awaitingPermission = false;
        await this.releaseParked();

        return;

      case "reset_conversation":
        this.queue.length = 0;
        this.echoed.clear();
        this.emitQueue();
        // Same supersede as `stop`: a turn still unwinding from the old
        // conversation must not drain into the new one.
        this.turn += 1;
        await this.session.resetConversation();
        // After the await, like `stop`: the reset aborts the in-flight turn.
        this.busy = false;

        return;

      case "enqueue":
        // Same as a send: a message that arrives mid-turn steers the turn.
        if (!isPrompt(command.message)) {
          return;
        }

        await this.runTurn(command.message);

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
          await this.runTurn(next.message);
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

  /**
   * Run one turn, then drain what the steer could not deliver: a message
   * parked behind an unanswered prompt, or one sent as the turn ended.
   */
  private async runTurn(message: string): Promise<void> {
    if (this.busy) {
      await this.admit(message);

      return;
    }

    this.busy = true;

    const turn = this.turn;

    try {
      await this.session.send(message);

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
        if (!this.echoed.delete(next.id)) {
          this.emit({
            type: "event",
            event: { type: "user_message_dequeued", content: next.message },
          });
        }
        await this.session.send(next.message);
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

  /**
   * A message sent mid-turn: steer it now, park it behind the prompt, or —
   * while a stop is landing — hold it for the turn after.
   */
  private async admit(message: string): Promise<void> {
    const entry: QueueEntry = {
      id: `q-${++this.queueIds}`,
      message,
      waitingFor: this.stopping
        ? "turn"
        : this.awaitingPermission
          ? "permission"
          : "step",
    };

    // The desktop already drew the bubble (it showed idle); don't draw two.
    if (this.stopping) this.echoed.add(entry.id);

    this.queue.push(entry);
    this.emitQueue();

    if (entry.waitingFor === "step") {
      await this.session.steer(message);
    }
  }

  /** Whatever arrived while the stop was landing runs now, as its own turn. */
  private async runAfterStop(): Promise<void> {
    const next = this.queue.shift();

    if (next === undefined) return;

    this.emitQueue(next.message);
    // Sent mid-turn it needs its bubble now; sent mid-stop it already has one.
    if (!this.echoed.delete(next.id)) {
      this.emit({
        type: "event",
        event: { type: "user_message_dequeued", content: next.message },
      });
    }
    await this.runTurn(next.message);
  }

  /** The prompt was answered: everything parked behind it is steered, in order. */
  private async releaseParked(): Promise<void> {
    for (const entry of this.queue) {
      if (entry.waitingFor !== "permission") continue;
      entry.waitingFor = "step";
      await this.session.steer(entry.message);
    }

    this.emitQueue();
  }

  /**
   * pi's steering queue is text in, text out — no ids — so an edit or a
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
  private onSessionEvent(event: DesktopEvent): void {
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
          this.queue.splice(index, 1);
        }

        this.emit(event);
        this.emitQueue();

        return;
      }
    }

    this.emit(event);
  }

  private emitQueue(dequeued: string | null = null): void {
    this.emit({ type: "queue_updated", messages: [...this.queue], dequeued });
  }

  private emit(event: DesktopEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

/** A promptable message: text, and not only whitespace. */
function isPrompt(message: unknown): message is string {
  return typeof message === "string" && message.trim().length > 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
