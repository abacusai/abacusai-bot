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
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import {
  FakeProvider,
  fakeProviderConfig,
  type RecordedCall,
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
  | { calls: number }
  /**
   * `--wire agui` only: wait on the AG-UI stream (a no-op under ndjson). For
   * pi-internal moments the legacy stream cannot see, such as an assistant
   * message having started before a Stop lands.
   */
  | { aguiUntil: (stdout: string) => boolean; label: string }
  /**
   * `--wire agui` only: a command built from the AG-UI stream so far, such
   * as a `permission.respond` carrying the descriptor's lineage or a
   * `cancel` naming the open run.
   */
  | { sendFrom: (stdout: string) => object; label: string };

export interface Scenario {
  name: string;
  mode?: string;
  env?: Record<string, string>;
  /** The fake model's replies, by request index. */
  reply?: (index: number, gates: Gates) => Reply | Promise<Reply>;
  /** Instead of `reply`: replies chosen from the request itself. */
  respond?: (
    call: RecordedCall,
    index: number,
    gates: Gates
  ) => Reply | Promise<Reply>;
  /** Runs once the fixed directories and the default config exist. */
  setup?: (paths: { root: string; home: string; cwd: string }) => void;
  /**
   * Serve the model through a proxy that gives every sub-agent's tool calls
   * the same provider ids (`child-<position>`), as providers that number
   * calls per message do: parallel children then reuse each other's ids.
   */
  collidingChildIds?: boolean;
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
  /** AG-UI stdout so far (agui hosts only). */
  stdout?(): string;
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
export function maskVolatile(
  bytes: string,
  ports: number | readonly number[]
): string {
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
  for (const port of typeof ports === "number" ? [ports] : ports) {
    out = out.split(`127.0.0.1:${port}`).join("127.0.0.1:<PORT>");
  }
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
  /** Every port the scenario's model is reachable on, for `maskVolatile`. */
  ports: number[];
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
  const proxy =
    scenario.collidingChildIds === true
      ? await startIdProxy(fake.port)
      : undefined;

  fs.writeFileSync(
    path.join(home, "config.json"),
    proxy != null
      ? fakeProviderConfig(fake)
          .split(`127.0.0.1:${fake.port}`)
          .join(`127.0.0.1:${proxy.port}`)
      : fakeProviderConfig(fake)
  );

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

  scenario.setup?.({ root, home, cwd });
  fake.calls.length = 0;
  fake.script((call, index) =>
    scenario.respond != null
      ? scenario.respond(call, index, gates)
      : (scenario.reply?.(index, gates) ?? { say: "ok" })
  );

  return {
    context: {
      cwd,
      ...(scenario.mode != null ? { mode: scenario.mode } : {}),
    },
    provider: fake,
    ports: proxy != null ? [fake.port, proxy.port] : [fake.port],
    gates,
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      proxy?.close();
    },
  };
}

/** A sub-agent's request: its prompt forbids delegating further. */
export const isChildCall = (call: RecordedCall): boolean =>
  call.messages.some(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes("You cannot delegate further")
  ) ||
  call.userText.some((text) => text.includes("You cannot delegate further"));

/**
 * Forwards to the fake provider; for a sub-agent's request, rewrites each
 * tool call id `call-<request>-<position>` to `child-<position>`, so two
 * sub-agents' calls carry the same provider id.
 */
async function startIdProxy(
  target: number
): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((request, response) => {
    let body = "";

    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const child = body.includes("You cannot delegate further");
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: target,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: `127.0.0.1:${target}` },
        },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");

            response.write(
              child
                ? text.replace(/"id":"call-\d+-(\d+)"/g, '"id":"child-$1"')
                : text
            );
          });
          reply.on("end", () => response.end());
        }
      );

      upstream.on("error", () => response.destroy());
      upstream.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      server.close();
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
    } else if ("aguiUntil" in step) {
      const stdout = host.stdout;

      if (stdout != null) {
        await until(
          () => step.aguiUntil(stdout()),
          () => `${scenario.name}: ${step.label}`
        );
      }
    } else if ("sendFrom" in step) {
      const stdout = host.stdout;

      if (stdout == null) {
        throw new Error(
          `${scenario.name}: ${step.label} needs the AG-UI stream (aguiSteps only)`
        );
      }
      host.write(JSON.stringify(step.sendFrom(stdout())));
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

/** An AguiHost with injected stdio; compat captured as its own byte stream. */
export function aguiDriver(
  start: (io: {
    stdin: PassThrough;
    writeStdout: (text: string) => void;
    compatWrite: (line: string) => void;
  }) => { run(): Promise<void> }
): HostDriver & { bytes(): string; stdout(): string } {
  const stdin = new PassThrough();
  let compat = "";
  let stdout = "";
  const host = start({
    stdin,
    writeStdout: (text) => {
      stdout += text;
    },
    compatWrite: (line) => {
      compat += line;
    },
  });
  const done = host.run();

  return {
    write: (line) => stdin.write(`${line}\n`),
    end: () => stdin.end(),
    done,
    legacy: () => parseLegacy(compat.slice(0, compat.lastIndexOf("\n") + 1)),
    bytes: () => compat,
    stdout: () => stdout,
  };
}

/**
 * An AG-UI stream with its volatile values made stable for a fixture:
 * timestamps dropped, server run ids and pi session ids numbered in order.
 */
export function normalizeAgui(
  stdout: string,
  ports: number | readonly number[]
): string {
  const ids = new Map<string, string>();
  let masked = stdout;
  let n = 0;

  for (const line of lines(stdout)) {
    const event = JSON.parse(line) as {
      name?: string;
      value?: { agentSessionId?: string; agentSessionFile?: string };
    };

    if (event.name !== "session.ready") continue;
    n += 1;
    if (event.value?.agentSessionFile != null)
      masked = masked
        .split(event.value.agentSessionFile)
        .join(`<SESSION_FILE_${n}>`);
    if (event.value?.agentSessionId != null)
      masked = masked
        .split(event.value.agentSessionId)
        .join(`<SESSION_ID_${n}>`);
  }

  masked = masked.split(GOLDEN_ROOT).join("<ROOT>");
  for (const port of typeof ports === "number" ? [ports] : ports) {
    masked = masked.split(`127.0.0.1:${port}`).join("127.0.0.1:<PORT>");
  }
  masked = masked
    .replace(/(delegate|document|deck|design|browser)-\d{13}-/g, "$1-<T>-")
    .replace(/srv-[0-9a-f-]{36}|<SESSION_ID_\d+>:\d{13}/g, (id) => {
      if (!ids.has(id)) {
        ids.set(
          id,
          id.startsWith("srv-")
            ? `srv-<${ids.size + 1}>`
            : `<MSG_${ids.size + 1}>`
        );
      }

      return ids.get(id)!;
    });

  return lines(masked)
    .map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;

      const timestamp =
        typeof event.timestamp === "number" ? event.timestamp : undefined;

      delete event.timestamp;

      // The incarnation is the host's fixed one and stays as is, so a wrong
      // lineage shows. An approval deadline is kept as its offset from the
      // event that carried it, to the second: a changed budget shows too.
      return JSON.stringify(event, (key, value: unknown) =>
        key === "expiresAt" && typeof value === "string" && timestamp != null
          ? `<now+${Math.round((Date.parse(value) - timestamp) / 1000)}s>`
          : value
      );
    })
    .join("\n")
    .concat("\n");
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

/** A checked-in fixture, never rewritten (the NDJSON baseline is read-only here). */
export function readGolden(name: string): string {
  return fs.readFileSync(fixturePath(name), "utf8");
}
