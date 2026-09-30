/**
 * The NDJSON host: stdin carries `DesktopCommand`, stdout carries `DesktopEvent`,
 * one JSON object per line. One process owns exactly one conversation.
 *
 * stdout is the protocol: a stray `console.log` corrupts a frame, so
 * diagnostics go to stderr. A command must never kill the process: a thrown
 * handler becomes an `error` event and the session stays alive.
 *
 * The queue and turn logic lives in agui/queue.ts, shared with the AG-UI host;
 * this host is that logic with stdout as its only writer (`--wire ndjson`).
 */
import { noCompat, type CompatWriter } from "./agui/channel.js";
import { HostCore } from "./agui/queue.js";
import { HostSink } from "./agui/sink.js";
import { isBotSession } from "./bot/bot-config.js";
import { BotSession } from "./bot/bot-session.js";
import type { DesktopEvent } from "./protocol.js";
import { AbacusBotSession } from "./session.js";

export interface HostOptions {
  cwd: string;
  model?: string;
  mode?: string;
}

export class NdjsonHost {
  private readonly core: HostCore;

  constructor(options: HostOptions) {
    // Looked up per write: the stream is process.stdout, as it always was.
    const stdout: CompatWriter = {
      ...noCompat,
      write: (line) => {
        process.stdout.write(line);
      },
    };
    const sink = new HostSink(stdout);
    const init = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      emit: (event: DesktopEvent) => this.core.onSessionEvent(event),
    };

    // A bot's chat runs the bot loop; everything else the coding session.
    // Decided by the spawn env so nothing above here knows there are two.
    const session = isBotSession()
      ? new BotSession(init)
      : new AbacusBotSession(init);

    this.core = new HostCore(session, (event) => sink.emit(event));
  }

  async run(): Promise<void> {
    await this.core.start();
    await this.core.readCommands(process.stdin, (command) =>
      this.core.handle(command)
    );
    await this.core.shutdown();
  }
}
