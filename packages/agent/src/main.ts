#!/usr/bin/env node
/**
 * The agent as a process, one per session. cwd is the workspace; stdio is the
 * protocol. `--wire ndjson` (the default) is the NDJSON protocol (host.ts);
 * `--wire agui` speaks AG-UI on stdout with the NDJSON lines on a
 * compatibility channel (agui/host.ts). Runs standalone too:
 *   echo '{"type":"send","message":"list the files here"}' | node dist/main.js
 */
import * as fs from "node:fs";

import {
  inlineWriter,
  noCompat,
  openFdWriter,
  preflightCompat,
  type CompatWriter,
} from "./agui/channel.js";
import { helloEvent, serialize } from "./agui/event.js";
import { AguiHost } from "./agui/host.js";
import { newIncarnation } from "./agui/ids.js";
import { useBundledTools } from "./bundled-tools.js";
import { applyStoredApiKeys } from "./config.js";
import { NdjsonHost } from "./host.js";
import { sandboxAvailability } from "./sandbox/index.js";

/** The AG-UI host, once there is one: its open run gets last words at exit. */
let aguiHost: AguiHost | undefined;

/**
 * A spawn whose binary is missing reports it on the child's 'error' event; a
 * library that forgets the listener turns that into an uncaughtException.
 * Those are cleanup noise: log and carry on. Anything else still exits, so
 * session recovery sees a dead agent rather than a corrupted live one.
 */
process.on("uncaughtException", (error: Error) => {
  const syscall = (error as NodeJS.ErrnoException).syscall;
  if (typeof syscall === "string" && syscall.startsWith("spawn")) {
    console.error(
      "[agent] ignored async spawn failure:",
      error.stack ?? error.message
    );
    return;
  }
  console.error("[agent] uncaught exception:", error.stack ?? error.message);
  aguiHost?.emergencyClose("agent_crashed");
  process.exit(1);
});

process.on("exit", () => {
  aguiHost?.emergencyClose("agent_exit");
});

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  // Keys saved in ~/.abacusai-bot; the environment wins, so under the desktop
  // app this changes nothing.
  applyStoredApiKeys();

  // Makes the bundled ripgrep and fd reachable; without it the first search on
  // a machine lacking them goes to the GitHub releases API.
  useBundledTools();

  const argv = process.argv.slice(2);

  // The desktop's one question before any session: can this machine confine
  // a command? One JSON line, then exit once it has flushed: a pipe write can
  // be asynchronous, and exiting first loses the line.
  if (argv.includes("--sandbox-probe")) {
    const verdict = JSON.stringify(await sandboxAvailability());

    process.stdout.write(`${verdict}\n`, () => process.exit(0));
    return;
  }

  const model = readFlag(argv, "--model");
  const mode = readFlag(argv, "--permission-mode");
  const wire = readFlag(argv, "--wire") ?? "ndjson";

  if (wire === "ndjson") {
    const host = new NdjsonHost({
      cwd: process.cwd(),
      ...(model != null ? { model } : {}),
      ...(mode != null ? { mode } : {}),
    });

    await host.run();

    return;
  }

  if (wire !== "agui") {
    throw new Error(`unknown --wire ${wire}; expected ndjson or agui`);
  }

  const threadId = readFlag(argv, "--thread-id");

  if (threadId == null || threadId.length === 0) {
    throw new Error("--wire agui needs --thread-id");
  }

  const compatFlag = readFlag(argv, "--compat-fd");
  const compatFd = compatFlag != null ? Number(compatFlag) : undefined;

  if (compatFd != null && !Number.isInteger(compatFd)) {
    throw new Error(
      `--compat-fd must be a descriptor number, not ${compatFlag}`
    );
  }

  // The handshake (spec §2.4): negotiated synchronously, before the session
  // exists and before either writer is enabled; `wire.hello` is stdout line 1.
  const incarnation = newIncarnation();
  const negotiated = preflightCompat(compatFd, incarnation);

  fs.writeSync(1, serialize(helloEvent(negotiated, incarnation)));

  const writeStdout = (text: string): void => {
    process.stdout.write(text);
  };
  const compat: CompatWriter =
    negotiated === "fd" && compatFd != null
      ? openFdWriter(compatFd, (error) => aguiHost?.compatLost(error))
      : negotiated === "inline"
        ? inlineWriter(writeStdout)
        : noCompat;

  aguiHost = new AguiHost({
    cwd: process.cwd(),
    ...(model != null ? { model } : {}),
    ...(mode != null ? { mode } : {}),
    threadId,
    incarnation,
    compat,
    writeStdout,
  });

  await aguiHost.run();
}

main().catch((error: unknown) => {
  // Startup failures already went out as a protocol `error` event; this is the
  // last-resort log for anything that escaped, and it must not touch stdout.
  process.stderr.write(
    `[abacusai-bot-agent] fatal: ${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exit(1);
});
