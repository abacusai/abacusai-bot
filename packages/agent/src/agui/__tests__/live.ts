/**
 * A live in-process AguiHost against the fake provider, for tests that need
 * more than a command script: ChatClient round trips, lineage checks, races.
 */
import type { Reply } from "@abacus-ai/test-support/fake-provider";

import type { DesktopEvent } from "../../protocol.js";
import { AbacusBotSession } from "../../session.js";
import { AguiHost, type SessionInit } from "../host.js";
import type { AguiEvent, PermissionDescriptor } from "../wire.js";
import { Gates, lines, parseLegacy, prepare } from "./harness.js";

export interface Live {
  host: AguiHost;
  gates: Gates;
  send(command: object): void;
  /** Every AG-UI event so far. */
  events(): AguiEvent[];
  compat(): DesktopEvent[];
  compatBytes(): string;
  /** Called with every AG-UI event as it is written. */
  onEvent(listener: (event: AguiEvent) => void): () => void;
  waitFor(
    check: (events: AguiEvent[]) => boolean,
    label: string,
    timeoutMs?: number
  ): Promise<void>;
  custom<T = unknown>(name: string): T[];
  providerCalls(): number;
  close(): Promise<void>;
}

export async function live(options: {
  reply: (index: number, gates: Gates) => Reply | Promise<Reply>;
  mode?: string;
  env?: Record<string, string>;
  incarnation?: string;
  /** Separate fixture files for parallel real-host renderer tests. */
  isolated?: boolean;
  /** Wraps the real session (e.g. to delay setModel). */
  wrap?: (session: AbacusBotSession) => AbacusBotSession;
  /** Runs after the fixed directories exist, before the host is built. */
  setup?: () => void;
  /** Let the host pick the session from the env (a bot when BOT_DIR is set). */
  realSessionChoice?: boolean;
}): Promise<Live> {
  const { PassThrough } = await import("node:stream");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = options.isolated
    ? fs.mkdtempSync(path.join(os.tmpdir(), "abacus-agui-live-"))
    : undefined;
  const { context, provider, gates, restore } = await prepare(
    {
      name: "live",
      ...(options.mode != null ? { mode: options.mode } : {}),
      ...(options.env != null ? { env: options.env } : {}),
      reply: options.reply,
      steps: [],
    },
    root
  );
  options.setup?.();
  const stdin = new PassThrough();
  let stdout = "";
  let compat = "";
  const listeners = new Set<(event: AguiEvent) => void>();
  const host = new AguiHost({
    cwd: context.cwd,
    ...(context.mode != null ? { mode: context.mode } : {}),
    threadId: "t-1",
    incarnation: options.incarnation ?? "inc-1",
    compat: {
      mode: "fd",
      write: (line) => {
        compat += line;
      },
    },
    stdin,
    writeStdout: (text) => {
      stdout += text;
      for (const line of lines(text)) {
        const event = JSON.parse(line) as AguiEvent;

        for (const listener of listeners) listener(event);
      }
    },
    exit: () => undefined,
    log: () => undefined,
    ...(options.realSessionChoice === true
      ? {}
      : {
          session: (init: SessionInit) => {
            const session = new AbacusBotSession(init);

            return options.wrap?.(session) ?? session;
          },
        }),
  });
  const done = host.run();
  const events = (): AguiEvent[] =>
    lines(stdout).map((line) => JSON.parse(line) as AguiEvent);
  const waitFor = async (
    check: (all: AguiEvent[]) => boolean,
    label: string,
    timeoutMs = 20_000
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (!check(events())) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}; saw ${events()
            .map((event) =>
              event.type === "CUSTOM" ? `CUSTOM:${event.name}` : event.type
            )
            .join(", ")}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  await waitFor(
    (all) =>
      all.some(
        (event) => event.type === "CUSTOM" && event.name === "mcp.servers"
      ),
    "startup"
  );

  return {
    host,
    gates,
    send: (command) => stdin.write(`${JSON.stringify(command)}\n`),
    events,
    compat: () => parseLegacy(compat),
    compatBytes: () => compat,
    onEvent: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    waitFor,
    custom: <T>(name: string) =>
      events()
        .filter((event) => event.type === "CUSTOM" && event.name === name)
        .map((event) => (event as { value: T }).value),
    providerCalls: () => provider.calls.length,
    close: async () => {
      stdin.end();
      await done;
      restore();
      if (root != null) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export const hasCustom =
  (name: string, count = 1) =>
  (events: AguiEvent[]): boolean =>
    events.filter((event) => event.type === "CUSTOM" && event.name === name)
      .length >= count;

export const hasType =
  (type: string, count = 1) =>
  (events: AguiEvent[]): boolean =>
    events.filter((event) => event.type === type).length >= count;

export const latestPending = (l: Live): PermissionDescriptor[] =>
  l.custom<{ items: PermissionDescriptor[] }>("permission.pending").at(-1)
    ?.items ?? [];

export function runInput(
  runId: string,
  text: string,
  extra: object = {}
): object {
  return {
    type: "run",
    input: {
      threadId: "t-1",
      runId,
      messages: [{ id: `u-${runId}`, role: "user", content: text }],
      tools: [],
      context: [],
      state: {},
      ...extra,
    },
  };
}
