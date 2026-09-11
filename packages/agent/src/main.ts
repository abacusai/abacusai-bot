#!/usr/bin/env node
/**
 * The agent as a process, one per session. cwd is the workspace; stdio is the
 * NDJSON protocol (see host.ts). Runs standalone too:
 *   echo '{"type":"send","message":"list the files here"}' | node dist/main.js
 */
import { useBundledTools } from "./bundled-tools.js";
import { applyStoredApiKeys } from "./config.js";
import { NdjsonHost } from "./host.js";

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
  process.exit(1);
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
  const model = readFlag(argv, "--model");
  const mode = readFlag(argv, "--permission-mode");

  const host = new NdjsonHost({
    cwd: process.cwd(),
    ...(model != null ? { model } : {}),
    ...(mode != null ? { mode } : {}),
  });

  await host.run();
}

main().catch((error: unknown) => {
  // Startup failures already went out as a protocol `error` event; this is the
  // last-resort log for anything that escaped, and it must not touch stdout.
  process.stderr.write(
    `[abacusai-bot-agent] fatal: ${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exit(1);
});
