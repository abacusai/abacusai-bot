/**
 * The manager's teardown promise, against a real child process.
 *
 * dispose() is what app quit awaits, and its contract is "resolved means the
 * children are gone". A dispose that resolves while an agent still runs lets
 * that agent — and everything it spawned — outlive the app.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentManagerService,
  killWithEscalation,
  type ExecFileLike,
  serializeCommand,
} from "./cli-manager-service";

/** A child that stays up until it is told to go. */
const IDLE_SCRIPT = "setInterval(() => {}, 1000);";

/** A child that dies the way a bad bundle does: one line on stderr, then gone. */
const DYING_SCRIPT =
  "process.stderr.write('ERR_MODULE_NOT_FOUND sharp\\n'); process.exit(3);";

let workspace: string | null = null;

const service = (script = IDLE_SCRIPT): AgentManagerService => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-manager-"));

  return new AgentManagerService({
    resolveWorkspacePath: () => workspace,
    resolveArtifact: () => ({
      execPath: process.execPath,
      execArgs: ["-e", script],
      agentRoot: workspace ?? "",
    }),
    resolveAuthEnv: () => ({}),
    resolveAdditionalConfigEnv: async () => ({}),
    emitStateUpdated: () => {},
    emitNdjson: () => {},
    emitSystemReady: () => {},
    emitSessionClosed: () => {},
    emitMcpRuntimeServers: () => {},
    emitMcpRuntimeStatus: () => {},
    emitMcpRuntimeLog: () => {},
    emitMcpRuntimeError: () => {},
    runHostService: async () => null,
  });
};

afterEach(() => {
  if (workspace != null) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe("disposing the manager", () => {
  it("resolves only once the child has actually exited", async () => {
    const manager = service();
    const started = await manager.startSession({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      startupTimeoutMs: 30_000,
    });

    expect(started.success).toBe(true);
    const pid = started.state.pid;
    expect(pid).not.toBeNull();

    await manager.dispose();

    if (process.platform !== "win32") {
      // Signal 0 probes for existence; a reaped child throws ESRCH.
      expect(() => process.kill(pid!, 0)).toThrow();
    }
  }, 15_000);

  it("resolves immediately when nothing is running", async () => {
    await service().dispose();
  });
});

describe("the child's stdin", () => {
  it("has an error handler from the start, so an async EPIPE cannot crash the app", async () => {
    const manager = service();

    await manager.startSession({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      startupTimeoutMs: 30_000,
    });

    // Reaching into the runtime map: the stream is deliberately not part of
    // the public surface, and the handler has to be there before any write.
    const internals = manager as unknown as {
      runtimes: Map<string, { process: { stdin: NodeJS.WriteStream } }>;
    };
    const stdin = internals.runtimes.get("session-1")?.process.stdin;

    expect(stdin?.listenerCount("error")).toBeGreaterThan(0);

    await manager.dispose();
  }, 15_000);
});

describe("stopping an agent on Windows", () => {
  /** A child that records what it was asked to do and never exits. */
  const child = (): {
    pid: number;
    signals: Array<string | undefined>;
    kill: (signal?: NodeJS.Signals) => boolean;
    once: (event: "close", listener: () => void) => unknown;
  } => ({
    pid: 4242,
    signals: [] as Array<string | undefined>,
    kill(signal?: NodeJS.Signals) {
      this.signals.push(signal);
      return true;
    },
    once: () => undefined,
  });

  /** A taskkill stand-in that reports `error` to its callback. */
  const taskkill = (
    error: Error | null
  ): { run: ExecFileLike; calls: unknown[][] } => {
    const calls: unknown[][] = [];

    return {
      calls,
      run: (file, args, options, callback) => {
        calls.push([file, args, options]);
        callback(error);
        return undefined;
      },
    };
  };

  it("takes the whole tree, hidden, and leaves the child unsignalled", () => {
    const target = child();
    const killer = taskkill(null);

    killWithEscalation(target, "win32", killer.run);

    expect(killer.calls[0]?.[0]).toBe("taskkill");
    expect(killer.calls[0]?.[1]).toEqual(["/pid", "4242", "/T", "/F"]);
    // Every teardown would otherwise flash a console window.
    expect(killer.calls[0]?.[2]).toMatchObject({ windowsHide: true });
    expect(target.signals).toEqual([]);
  });

  it("falls back to the signal path when taskkill fails", () => {
    // taskkill can be missing from PATH, or refused for an elevated child.
    // Without the fallback the agent was never signalled at all: Stop reported
    // success, dispose() waited out its full cap, and the process was orphaned.
    const target = child();

    killWithEscalation(target, "win32", taskkill(new Error("ENOENT")).run);

    expect(target.signals).toEqual([undefined]);
  });

  it("still escalates to SIGKILL after the fallback", () => {
    vi.useFakeTimers();
    try {
      const target = child();

      killWithEscalation(target, "win32", taskkill(new Error("denied")).run);
      vi.advanceTimersByTime(10_000);

      expect(target.signals).toEqual([undefined, "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reaches for taskkill off Windows", () => {
    const target = child();
    const killer = taskkill(null);

    killWithEscalation(target, "darwin", killer.run);

    expect(killer.calls).toHaveLength(0);
    expect(target.signals).toEqual([undefined]);
  });
});

/**
 * A session that dies is exactly the session a bug report is about, and its
 * runtime is deleted the moment the process closes. What it said on the way
 * out has to outlive it, or the dump taken seconds later is empty.
 */
describe("diagnostics for a session that has gone", () => {
  it("keeps the dead child's stderr, exit code and command", async () => {
    const manager = service(DYING_SCRIPT);

    await manager.startSession({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      startupTimeoutMs: 5_000,
    });

    await vi.waitFor(() => {
      const dead = manager.getRuntimeDiagnostics().find((entry) => !entry.live);

      expect(dead).toBeDefined();
      expect(dead?.stderr).toContain("ERR_MODULE_NOT_FOUND");
      expect(dead?.state.exitCode).toBe(3);
      expect(dead?.command).toContain(process.execPath);
    });

    await manager.dispose();
  });

  it("records a session whose agent could not be found at all", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-manager-"));
    const manager = new AgentManagerService({
      resolveWorkspacePath: () => workspace,
      resolveArtifact: () => {
        throw new Error('agent entry not found. Run "pnpm build" first.');
      },
      resolveAuthEnv: () => ({}),
      resolveAdditionalConfigEnv: async () => ({}),
      emitStateUpdated: () => {},
      emitNdjson: () => {},
      emitSystemReady: () => {},
      emitSessionClosed: () => {},
      emitMcpRuntimeServers: () => {},
      emitMcpRuntimeStatus: () => {},
      emitMcpRuntimeLog: () => {},
      emitMcpRuntimeError: () => {},
      runHostService: async () => null,
    });

    const started = await manager.startSession({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      startupTimeoutMs: 5_000,
    });

    expect(started.success).toBe(false);
    const [record] = manager.getRuntimeDiagnostics();
    expect(record?.live).toBe(false);
    expect(record?.command).toBe("(agent artifact unresolved)");
    expect(record?.state.error).toContain("agent entry not found");
  });
});

describe("a command on its way to the agent", () => {
  // The agent reads stdin with readline, which ends a line on U+2028 and
  // U+2029 as well as "\n". JSON leaves both raw inside a string, so a
  // persona pasted from Apple Notes split the command in two: the agent
  // dropped both halves as malformed and the routine never ran.
  const readsBackAsOneLine = async (payload: string): Promise<string[]> => {
    const readline = await import("node:readline");
    const { Readable } = await import("node:stream");
    const lines: string[] = [];
    const input = readline.createInterface({
      input: Readable.from([`${payload}\n`]),
    });
    for await (const line of input) lines.push(line);
    return lines;
  };

  it("survives a line separator in the message", async () => {
    const command = {
      type: "send",
      message:
        "You are Chief of staff.\nYour voice: Proactive, decisive, concise\u2028Instruction\n\n[routine] fired",
    };

    const lines = await readsBackAsOneLine(serializeCommand(command));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(command);
  });

  it("survives a paragraph separator too", async () => {
    const command = { type: "send", message: "one\u2029two" };

    const lines = await readsBackAsOneLine(serializeCommand(command));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(command);
  });

  it("is plain JSON.stringify for everything else", () => {
    const command = { type: "send", message: "tabs\tand\nnewlines" };

    expect(serializeCommand(command)).toBe(JSON.stringify(command));
  });
});
