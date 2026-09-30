/**
 * In-process harness for the wire goldens (spec 00-agent-agui §7.1-§7.2).
 *
 * A scenario is a command script plus the fake provider's replies. The same
 * scenario is run through `--wire ndjson` (the production NdjsonHost, driven
 * through process.stdin/stdout exactly as main.ts drives it) and through
 * `--wire agui` (AguiHost with injected streams), and the legacy bytes are
 * compared.
 *
 * Determinism: the provider numbers its tool calls, paths live under one fixed
 * root, and the few values that are random or clock-derived by construction
 * (pi's uuidv7 session id and file, the fake provider's port,
 * `Date.now()`-derived subtask ids) are masked by `maskVolatile`. Nothing else
 * is normalised.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import {
  FakeProvider,
  fakeProviderConfig,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";

import type { DesktopCommand, DesktopEvent } from "../../protocol.js";

export const GOLDEN_ROOT = path.join(os.tmpdir(), "abacus-agui-golden");

/** Named gates a responder can wait on and a step can open. */
export class Gates {
  private readonly waiting = new Map<string, () => void>();
  private readonly opened = new Set<string>();

  wait(name: string): Promise<void> {
    if (this.opened.has(name)) return Promise.resolve();

    return new Promise((resolve) => this.waiting.set(name, resolve));
  }

  open(name: string): void {
    this.opened.add(name);
    this.waiting.get(name)?.();
    this.waiting.delete(name);
  }
}

export type Step =
  /** A command, or a raw stdin line (for the malformed-input case). */
  | { send: DesktopCommand | Record<string, unknown> | string }
  /** Wait until the legacy events so far satisfy `until`. */
  | { until: (events: DesktopEvent[]) => boolean; label: string }
  /** Open a gate a responder is holding a request on. */
  | { release: string }
  /** Wait until the provider has had exactly this many requests. */
  | { calls: number };

export interface Scenario {
  name: string;
  mode?: string;
  env?: Record<string, string>;
  /** The fake model's replies, by request index. */
  reply: (index: number, gates: Gates) => Reply | Promise<Reply>;
  steps: Step[];
}

/** What a host under test exposes to the runner. */
export interface HostDriver {
  /** stdin */
  write(line: string): void;
  end(): void;
  /** Resolves when the host's run() returned. */
  done: Promise<void>;
  /** Legacy events seen so far (from stdout under ndjson, compat under agui). */
  legacy(): DesktopEvent[];
}

export interface RunContext {
  cwd: string;
  mode?: string;
}

let provider: FakeProvider | undefined;

export async function startProvider(): Promise<FakeProvider> {
  provider ??= await FakeProvider.start();

  return provider;
}

export async function stopProvider(): Promise<void> {
  await provider?.close();
  provider = undefined;
}

/** Split complete lines out of a byte stream. */
export function lines(bytes: string): string[] {
  return bytes.split("\n").filter((line) => line.length > 0);
}

export function parseLegacy(bytes: string): DesktopEvent[] {
  return lines(bytes).map((line) => JSON.parse(line) as DesktopEvent);
}

/**
 * Replace the values that differ between two runs of the same scenario by
 * construction. Everything else must match byte for byte.
 */
export function maskVolatile(bytes: string, port: number): string {
  let out = bytes;
  const ready = lines(bytes)
    .map((line) => {
      try {
        return JSON.parse(line) as DesktopEvent;
      } catch {
        return null;
      }
    })
    .filter(
      (event): event is Extract<DesktopEvent, { type: "ready" }> =>
        event?.type === "ready"
    );

  let n = 0;
  for (const event of ready) {
    n += 1;
    if (event.agentSessionFile != null)
      out = out.split(event.agentSessionFile).join(`<SESSION_FILE_${n}>`);
    if (event.agentSessionId != null)
      out = out.split(event.agentSessionId).join(`<SESSION_ID_${n}>`);
  }

  out = out.split(GOLDEN_ROOT).join("<ROOT>");
  out = out.split(`127.0.0.1:${port}`).join("127.0.0.1:<PORT>");
  out = out.replace(
    /(delegate|document|deck|design|browser)-\d{13}-/g,
    "$1-<T>-"
  );

  return out;
}

/**
 * Fresh fixed directories and env for a scenario. Returns a restore callback.
 */
export async function prepare(scenario: Scenario): Promise<{
  context: RunContext;
  provider: FakeProvider;
  gates: Gates;
  restore: () => void;
}> {
  const fake = await startProvider();
  const root = GOLDEN_ROOT;
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");

  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), fakeProviderConfig(fake));

  const saved = new Map<string, string | undefined>();
  const userHome = path.join(root, "user");

  fs.mkdirSync(userHome, { recursive: true });

  // The user's own skills and settings live under $HOME; a golden must not
  // depend on whose machine recorded it.
  const env: Record<string, string> = {
    HOME: userHome,
    USERPROFILE: userHome,
    ABACUSAI_BOT_HOME: home,
    ...scenario.env,
  };

  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  const gates = new Gates();

  fake.calls.length = 0;
  fake.script((_call, index) => scenario.reply(index, gates));

  return {
    context: {
      cwd,
      ...(scenario.mode != null ? { mode: scenario.mode } : {}),
    },
    provider: fake,
    gates,
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function until(
  check: () => boolean,
  describe: () => string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Run the script against a started host, then close stdin and wait. */
export async function drive(
  scenario: Scenario,
  host: HostDriver,
  fake: FakeProvider,
  gates: Gates
): Promise<void> {
  // Every command is sent once the session is up, so the order of startup
  // lines against the first command's lines is fixed.
  await until(
    () => host.legacy().some((event) => event.type === "ready"),
    () => "ready"
  );
  await until(
    () => host.legacy().some((event) => event.type === "mcp_servers"),
    () => "mcp_servers"
  );

  for (const step of scenario.steps) {
    if ("send" in step) {
      host.write(
        typeof step.send === "string" ? step.send : JSON.stringify(step.send)
      );
    } else if ("until" in step) {
      await until(
        () => step.until(host.legacy()),
        () =>
          `${scenario.name}: ${step.label}; saw ${host
            .legacy()
            .map((event) =>
              event.type === "event" ? `event:${event.event.type}` : event.type
            )
            .join(", ")}`
      );
    } else if ("release" in step) {
      gates.open(step.release);
    } else {
      await until(
        () => fake.calls.length >= step.calls,
        () => `${scenario.name}: ${step.calls} calls, saw ${fake.calls.length}`
      );
    }
  }

  host.end();
  await host.done;
}

/**
 * The production NdjsonHost, reached exactly as main.ts reaches it: through
 * process.stdin and process.stdout.
 */
export function ndjsonDriver(
  start: (context: RunContext) => { run(): Promise<void> },
  context: RunContext
): HostDriver & { bytes(): string } {
  const stdin = new PassThrough();
  let captured = "";
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalWrite = process.stdout.write.bind(process.stdout);

  Object.defineProperty(process, "stdin", {
    value: stdin,
    configurable: true,
    writable: true,
  });
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    const callback = rest.find((arg) => typeof arg === "function") as
      | (() => void)
      | undefined;
    callback?.();

    return true;
  }) as typeof process.stdout.write;

  const restore = (): void => {
    process.stdout.write = originalWrite;
    if (originalStdin != null)
      Object.defineProperty(process, "stdin", originalStdin);
  };

  const host = start(context);
  const done = host.run().finally(restore);

  return {
    write: (line) => stdin.write(`${line}\n`),
    end: () => stdin.end(),
    done,
    legacy: () =>
      parseLegacy(captured.slice(0, captured.lastIndexOf("\n") + 1)),
    bytes: () => captured,
  };
}

/** Streams for a host that takes injected stdio. */
export function injectedStreams(): {
  stdin: PassThrough;
  stdout: Writable & { text(): string };
  compat: Writable & { text(): string };
} {
  const sink = (): Writable & { text(): string } => {
    let text = "";
    const stream = new PassThrough() as unknown as Writable & {
      text(): string;
    };
    (stream as unknown as Readable).on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    stream.text = () => text;

    return stream;
  };

  return { stdin: new PassThrough(), stdout: sink(), compat: sink() };
}

export const fixturePath = (name: string): string =>
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "__fixtures__",
    name
  );

/** Compare with a checked-in fixture, or write it when UPDATE_GOLDENS=1. */
export function golden(name: string, actual: string): string | null {
  const file = fixturePath(name);

  if (process.env.UPDATE_GOLDENS === "1") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);

    return null;
  }

  if (!fs.existsSync(file)) {
    throw new Error(`missing golden ${name}; record with UPDATE_GOLDENS=1`);
  }

  return fs.readFileSync(file, "utf8");
}
