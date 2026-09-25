import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import { existsSync } from "fs";
import { delimiter } from "path";

import { agentVendorDir } from "#main/resources";
import {
  AgentMode,
  AgentStatus,
  type CliMcpLogEntry,
  type CliMcpServerSnapshot,
  type CliMcpStatusEvent,
  type DesktopCommand,
  type DesktopEvent,
  type HostService,
} from "#shared/agent-types";
import type {
  AgentMcpLogEntry,
  AgentMcpServer,
  AgentMcpStatus,
  AgentSessionSnapshot,
  AgentSessionStatus,
  StartAgentSessionRequest,
  StartAgentSessionResult,
  StopAgentSessionResult,
} from "#shared/contracts";
import { WORKSPACE_MISSING_ERROR } from "#shared/contracts";

import { describeAgentEvent } from "../diagnostics/agent-event-log";
import { logStore } from "../diagnostics/log-store";
import type { ResolvedAgentArtifact } from "./artifact-resolver-service";

/** Max diagnostic log entries retained per server in the desktop process. */
const MCP_LOG_TAIL_PER_SERVER = 200;

/**
 * Spawn the agent with `--debug` (ABACUSAI_BOT_AGENT_DEBUG=1). Off by default:
 * stdout is the NDJSON channel and --debug may write there.
 */
const shouldRunCliInDebugMode = (): boolean =>
  process.env.ABACUSAI_BOT_AGENT_DEBUG === "1";

type CliRuntime = {
  workspaceId: string;
  sessionId: string;
  process: ChildProcessWithoutNullStreams;
  state: AgentSessionSnapshot;
  stdoutBuffer: string;
  stderrBuffer: string;
  /** Last known runtime state of each MCP server (keyed by server id). */
  mcpServers: Map<string, AgentMcpServer>;
  /** Rolling log tail per MCP server. Most recent last. */
  mcpLogs: Map<string, AgentMcpLogEntry[]>;
  /** True once this spawn's outcome has been finalized (dedupes failure logging). */
  spawnResultReported: boolean;
  /** Set on startup failure so a late `ready` cannot revive the session. */
  startupFailed: boolean;
  /** Exactly what was executed, for a log dump reading a spawn that failed. */
  command: string;
};

/**
 * What survives a session whose process has gone: the runtime is deleted on
 * close, and a child that dies inside a second explains itself only on stderr.
 */
type ExitedRuntimeRecord = {
  workspaceId: string;
  sessionId: string;
  state: AgentSessionSnapshot;
  stderr: string;
  mcpServers: AgentMcpServer[];
  command: string;
  mcpLogs: Array<{ serverId: string; entries: AgentMcpLogEntry[] }>;
};

/** Exited sessions kept for the dump. Enough for a bad startup loop. */
const MAX_EXITED_RECORDS = 20;

type AgentManagerServiceOptions = {
  resolveWorkspacePath: (
    workspaceId: string,
    sessionId: string
  ) => string | null;
  resolveArtifact: () => ResolvedAgentArtifact;
  resolveAuthEnv: () => Record<string, string>;
  resolveAdditionalConfigEnv: (
    sessionId: string
  ) => Promise<Record<string, string>>;
  emitStateUpdated: (
    workspaceId: string,
    sessionId: string,
    state: AgentSessionSnapshot
  ) => void;
  emitNdjson: (
    workspaceId: string,
    sessionId: string,
    event: DesktopEvent
  ) => void;
  emitSystemReady: (workspaceId: string, sessionId: string) => void;
  emitSessionClosed: (workspaceId: string, sessionId: string) => void;
  /** Full MCP runtime snapshot for a session. Broadcast on update. */
  emitMcpRuntimeServers: (
    workspaceId: string,
    sessionId: string,
    servers: AgentMcpServer[]
  ) => void;
  /** Per-server status transition. Fires on every change. */
  emitMcpRuntimeStatus: (
    workspaceId: string,
    sessionId: string,
    event: {
      serverId: string;
      status: AgentMcpStatus;
      error?: string;
      authUrl?: string;
      pid?: number;
      ts: string;
    }
  ) => void;
  /** Per-line MCP log entry (notification / stderr / transport). */
  emitMcpRuntimeLog: (
    workspaceId: string,
    sessionId: string,
    entry: AgentMcpLogEntry
  ) => void;
  /** CLI-side failure (refresh / restart threw), so the dialog can toast it. */
  emitMcpRuntimeError: (
    workspaceId: string,
    sessionId: string,
    event:
      | { kind: "refresh"; error: string; ts: string }
      | { kind: "restart"; serverId: string; error: string; ts: string }
  ) => void;
  /**
   * A service only this process can perform, asked for by an agent tool. A
   * rejection is reported to the agent as a failed service, not a dead session.
   */
  runHostService: (service: HostService, payload: unknown) => Promise<unknown>;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
// 16MB: NDJSON lines carry whole tool outputs (diffs, base64 screenshots); a
// smaller cap truncates a line's head and the tool result vanishes mid-turn.
const MAX_BUFFER_SIZE = 16 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL when stopping a wedged agent. */
const KILL_ESCALATION_MS = 5_000;

/** The child surface the kill path needs, so a test can stand in for one. */
type KillableChild = {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => unknown;
  once: (event: "close", listener: () => void) => unknown;
};

/** The subset of `execFile` the tree kill needs. */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { windowsHide: boolean },
  callback: (error: Error | null) => void
) => unknown;

/**
 * Stop an agent process and everything it started: SIGTERM, then SIGKILL
 * after a grace period, or a wedged agent survives Stop and app quit. On
 * Windows kill() is TerminateProcess and leaves children alive, so taskkill
 * /T takes the tree; if that fails, terminate directly rather than do nothing.
 */
/**
 * One command, one line. JSON leaves U+2028 and U+2029 unescaped (they are
 * legal inside a JSON string) but the agent reads stdin with readline, which
 * ends a line on either, so a persona pasted from Apple Notes arrived as two
 * malformed lines and the routine never ran. Both are valid JSON escapes.
 */
export function serializeCommand(command: unknown): string {
  return JSON.stringify(command)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function killWithEscalation(
  child: KillableChild,
  platform: NodeJS.Platform = process.platform,
  runExecFile: ExecFileLike = execFile as unknown as ExecFileLike
): void {
  const escalate = (): void => {
    try {
      child.kill();
    } catch {
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_ESCALATION_MS);
    // Never keep the app alive just to deliver a SIGKILL.
    killTimer.unref();
    child.once("close", () => clearTimeout(killTimer));
  };

  if (platform === "win32" && child.pid != null) {
    // windowsHide: without it every teardown flashes a console window.
    runExecFile(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true },
      (error) => {
        if (error != null) escalate();
      }
    );

    return;
  }

  escalate();
}

const toStatus = (runtime: CliRuntime | null): AgentSessionStatus => {
  if (runtime == null) {
    return "stopped";
  }
  return runtime.state.status;
};

const buildStoppedState = (
  workspaceId: string,
  sessionId: string
): AgentSessionSnapshot => ({
  workspaceId,
  sessionId,
  status: "stopped",
  pid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  error: null,
  model: null,
  mode: null,
  agentStatus: AgentStatus.Idle,
});

const sanitizeEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      next[key] = value;
    }
  }
  return next;
};

const trimBuffer = (value: string): string => {
  if (value.length <= MAX_BUFFER_SIZE) {
    return value;
  }
  return value.slice(value.length - MAX_BUFFER_SIZE);
};

const drainLines = (rawBuffer: string): { lines: string[]; rest: string } => {
  const normalized = rawBuffer.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0) {
    return { lines: [], rest: "" };
  }
  const rest = lines.pop() ?? "";
  return { lines, rest };
};

/**
 * One main-log line per connect outcome. Transitions only: the roster is
 * re-sent on every refresh, and "connecting" is noise.
 */
function logMcpOutcome(
  sessionId: string,
  prev: AgentMcpServer | undefined,
  next: AgentMcpServer
): void {
  if (next.status === "connecting") return;
  if (
    prev != null &&
    prev.status === next.status &&
    prev.toolCount === next.toolCount &&
    prev.error === next.error
  )
    return;
  const detail =
    next.status === "connected"
      ? `${next.toolCount} tool(s)`
      : next.status === "auth-required"
        ? "needs a sign-in"
        : (next.error ?? "");
  console.log(
    `[mcp] ${next.name}: ${next.status}${detail.length > 0 ? ` (${detail})` : ""} (session ${sessionId.slice(0, 8)})`
  );
}

// Near-identical shapes, kept distinct so the desktop-renderer contract does
// not leak CLI-internal type changes.
const snapshotFromCli = (s: CliMcpServerSnapshot): AgentMcpServer => ({
  id: s.id,
  name: s.name,
  transport: s.transport,
  status: s.status,
  toolCount: s.toolCount,
  ...(s.error != null ? { error: s.error } : {}),
  ...(s.authUrl != null ? { authUrl: s.authUrl } : {}),
  ...(s.pid != null ? { pid: s.pid } : {}),
  ...(s.connectedAt != null ? { connectedAt: s.connectedAt } : {}),
  ...(s.updatedAt != null ? { updatedAt: s.updatedAt } : {}),
});

const parseMode = (value: unknown): AgentMode | null => {
  if (typeof value !== "string") {
    return null;
  }
  if (
    value === AgentMode.Normal ||
    value === AgentMode.AcceptEdits ||
    value === AgentMode.PlanMode ||
    value === AgentMode.Auto ||
    value === AgentMode.Yolo
  ) {
    return value;
  }
  return null;
};

// The OS error code and binary path are what tell a support log why a spawn
// died at exec (ENOENT / EACCES / exec-format).
const logCliSpawnFailure = (
  workspaceId: string,
  sessionId: string,
  binaryPath: string,
  reason: {
    code?: string;
    signal?: NodeJS.Signals | null;
    exitCode?: number | null;
    message?: string;
    stderrTail?: string;
  }
): void => {
  console.error(
    `[CLI] spawn failed ${workspaceId}/${sessionId} bin=${binaryPath} ${JSON.stringify(
      {
        code: reason.code ?? null,
        signal: reason.signal ?? null,
        exitCode: reason.exitCode ?? null,
        message: reason.message ?? null,
        stderrTail: reason.stderrTail?.slice(-600) || null,
      }
    )}`
  );
};

export class AgentManagerService {
  private readonly runtimes = new Map<string, CliRuntime>();
  /** Sessions whose process has gone. See ExitedRuntimeRecord. */
  private readonly exited: ExitedRuntimeRecord[] = [];

  constructor(private readonly options: AgentManagerServiceOptions) {}

  /**
   * Stop every session, resolving once each child has exited. The quit path
   * awaits this; returning early lets a wedged agent outlive the app.
   */
  dispose(): Promise<void> {
    const exits = [...this.runtimes.values()].map(
      (runtime) =>
        new Promise<void>((resolve) => {
          const child = runtime.process;
          if (child.exitCode != null || child.signalCode != null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
        })
    );
    for (const sessionId of this.runtimes.keys()) {
      this.stopSessionById(sessionId);
    }
    this.runtimes.clear();
    return Promise.all(exits).then(() => undefined);
  }

  /**
   * The permission mode a running session was started in, or null. The
   * built-in MCP servers prompt from this process and need to know Bypass.
   */
  getSessionMode(sessionId: string): AgentMode | null {
    return this.runtimes.get(sessionId)?.state.mode ?? null;
  }

  getSessionState(
    workspaceId: string,
    sessionId: string
  ): AgentSessionSnapshot {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null) {
      return buildStoppedState(workspaceId, sessionId);
    }
    return { ...runtime.state };
  }

  async startSession(
    request: StartAgentSessionRequest
  ): Promise<StartAgentSessionResult> {
    const workspacePath = this.options.resolveWorkspacePath(
      request.workspaceId,
      request.sessionId
    );
    if (workspacePath == null) {
      return {
        success: false,
        created: false,
        state: buildStoppedState(request.workspaceId, request.sessionId),
        error: "Workspace path is unavailable.",
      };
    }

    // Node reports a missing cwd as ENOENT naming the binary, which reads as
    // a broken install.
    if (!existsSync(workspacePath)) {
      const message = `${WORKSPACE_MISSING_ERROR}:${workspacePath}`;
      return {
        success: false,
        created: false,
        state: {
          ...buildStoppedState(request.workspaceId, request.sessionId),
          status: "error",
          error: message,
        },
        error: message,
      };
    }

    const existingRuntime = this.runtimes.get(request.sessionId);
    if (
      existingRuntime != null &&
      (toStatus(existingRuntime) === "starting" ||
        toStatus(existingRuntime) === "running")
    ) {
      return {
        success: true,
        created: false,
        state: { ...existingRuntime.state },
      };
    }

    // Refuse a start while the previous process is still stopping: the old
    // child's close handler would delete the new runtime, orphaning it.
    if (existingRuntime != null && toStatus(existingRuntime) === "stopping") {
      return {
        success: false,
        created: false,
        state: { ...existingRuntime.state },
        error: "Session is still stopping; retry once it has stopped.",
      };
    }

    const startupTimeoutMs =
      request.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let artifact: ResolvedAgentArtifact;
    try {
      artifact = this.options.resolveArtifact();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A missing agent is a packaging failure, not a spawn one; log it so.
      logCliSpawnFailure(
        request.workspaceId,
        request.sessionId,
        "(agent artifact unresolved)",
        { message }
      );
      const state = {
        ...buildStoppedState(request.workspaceId, request.sessionId),
        status: "error" as const,
        error: message,
      };

      this.recordExit({
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        state,
        stderr: "",
        mcpServers: [],
        command: "(agent artifact unresolved)",
        mcpLogs: [],
      });

      return { success: false, created: false, state, error: message };
    }

    const sanitized = sanitizeEnv(process.env);
    // An agent spawned from an installed experience lives under userData, so
    // the vendored rg/fd ride the child's PATH (appended: the user's own still
    // win). A PATH nicety must never break a spawn, hence the guard.
    try {
      const vendor = agentVendorDir();
      if (
        existsSync(vendor) &&
        !(sanitized.PATH ?? "").split(delimiter).includes(vendor)
      ) {
        sanitized.PATH =
          sanitized.PATH == null || sanitized.PATH === ""
            ? vendor
            : `${sanitized.PATH}${delimiter}${vendor}`;
      }
    } catch {
      // Vendor resolution unavailable; the agent falls back to PATH.
    }
    const env = {
      ...sanitized,
      // The agent entry is a plain Node script run by Electron's own binary.
      ELECTRON_RUN_AS_NODE: "1",
      ABACUSAI_BOT_CLIENT_KIND: "desktop_code_mode",
      // Lets the agent pick this chat back up; without it the restored
      // transcript is visible on screen and unknown to the model.
      ABACUSAI_BOT_SESSION_ID: request.sessionId,
      ...this.options.resolveAuthEnv(),
      ...(await this.options.resolveAdditionalConfigEnv(request.sessionId)),
    };

    const spawnArgs: string[] = [...artifact.execArgs];
    if (request.model != null && request.model.length > 0)
      spawnArgs.push("--model", request.model);
    if (request.mode != null) spawnArgs.push("--permission-mode", request.mode);
    // See shouldRunCliInDebugMode.
    if (shouldRunCliInDebugMode()) spawnArgs.push("--debug");
    const command = `${artifact.execPath} ${spawnArgs.join(" ")}`;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(artifact.execPath, spawnArgs, {
        cwd: workspacePath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A synchronous spawn() throw must reach the dump with the interpreter
      // and OS error named.
      logCliSpawnFailure(request.workspaceId, request.sessionId, command, {
        code: (error as NodeJS.ErrnoException | undefined)?.code,
        message,
      });
      const state = {
        ...buildStoppedState(request.workspaceId, request.sessionId),
        status: "error" as const,
        error: message,
      };

      this.recordExit({
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        state,
        stderr: "",
        mcpServers: [],
        command,
        mcpLogs: [],
      });

      return { success: false, created: false, state, error: message };
    }

    // An async EPIPE from a dying child bypasses sendCommand's try/catch;
    // without a handler on the stream it is an uncaught exception.
    child.stdin.on("error", () => {});

    const startedAt = new Date().toISOString();
    const runtime: CliRuntime = {
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      process: child,
      stdoutBuffer: "",
      stderrBuffer: "",
      mcpServers: new Map(),
      mcpLogs: new Map(),
      spawnResultReported: false,
      startupFailed: false,
      command,
      state: {
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        status: "starting",
        pid: child.pid ?? null,
        startedAt,
        stoppedAt: null,
        exitCode: null,
        error: null,
        model: null,
        mode: null,
        agentStatus: AgentStatus.LoadingConversation,
      },
    };

    this.runtimes.set(request.sessionId, runtime);
    this.options.emitStateUpdated(request.workspaceId, request.sessionId, {
      ...runtime.state,
    });

    // True while the runtimes entry still belongs to this spawn; after an
    // overwrite the old child's callbacks must not touch the new runtime.
    const ownsSession = (): boolean =>
      this.runtimes.get(request.sessionId)?.process === child;

    let startupResolved = false;
    const startupTimer = setTimeout(() => {
      if (startupResolved) {
        return;
      }
      startupResolved = true;
      if (!ownsSession()) {
        return;
      }
      runtime.startupFailed = true;
      this.reportSpawnResultOnce(request.sessionId);
      this.updateRuntimeState(request.sessionId, {
        status: "error",
        error: `Local CLI did not emit ready event within ${startupTimeoutMs}ms.`,
      });
      // Reap the child, or a late `ready` arrives for a failed session and
      // the process lingers forever.
      killWithEscalation(child);
    }, startupTimeoutMs);

    const resolveStartup = (): void => {
      if (startupResolved) {
        return;
      }
      startupResolved = true;
      clearTimeout(startupTimer);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!ownsSession()) {
        return;
      }
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.handleStdout(request.sessionId, data, resolveStartup);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      runtime.stderrBuffer = trimBuffer(runtime.stderrBuffer + data);
      // Also to disk: a child that exits explains itself here and nowhere else.
      for (const line of data.split("\n")) {
        if (line.trim().length > 0) {
          logStore().append(
            "agent",
            `[${request.sessionId.slice(0, 8)}] stderr ${line.trimEnd()}`
          );
        }
      }
    });

    child.on("error", (error) => {
      resolveStartup();
      logCliSpawnFailure(
        request.workspaceId,
        request.sessionId,
        artifact.execArgs.join(" "),
        {
          code: (error as NodeJS.ErrnoException).code,
          message: error.message,
        }
      );
      if (!ownsSession()) {
        return;
      }
      runtime.startupFailed = true;
      this.reportSpawnResultOnce(request.sessionId);
      this.updateRuntimeState(request.sessionId, {
        status: "error",
        error: error.message,
      });
    });

    child.on("close", (code, signal) => {
      resolveStartup();
      const current = this.runtimes.get(request.sessionId);
      // A replacement session's entry belongs to its own close handler.
      if (current == null || current.process !== child) {
        return;
      }
      // Early exit before ever reaching ready counts as a failed spawn.
      if (!current.spawnResultReported) {
        logCliSpawnFailure(
          request.workspaceId,
          request.sessionId,
          artifact.execArgs.join(" "),
          {
            exitCode: code,
            signal,
            message: current.state.error ?? undefined,
            stderrTail: current.stderrBuffer,
          }
        );
        this.reportSpawnResultOnce(request.sessionId);
      }
      const isError = current.state.status === "error";
      current.state = {
        ...current.state,
        status: isError ? "error" : "stopped",
        pid: null,
        exitCode: code,
        stoppedAt: new Date().toISOString(),
      };
      this.options.emitStateUpdated(current.workspaceId, current.sessionId, {
        ...current.state,
      });
      this.options.emitSessionClosed(current.workspaceId, current.sessionId);
      logStore().append(
        "agent",
        `[${current.sessionId.slice(0, 8)}] exited code=${code ?? "-"} signal=${signal ?? "-"} status=${current.state.status}`
      );
      this.recordExit({
        workspaceId: current.workspaceId,
        sessionId: current.sessionId,
        state: { ...current.state },
        stderr: current.stderrBuffer,
        mcpServers: [...current.mcpServers.values()],
        command: current.command,
        mcpLogs: [...current.mcpLogs.entries()].map(([serverId, entries]) => ({
          serverId,
          entries: [...entries],
        })),
      });
      this.runtimes.delete(request.sessionId);
    });

    return {
      success: true,
      created: true,
      state: { ...runtime.state },
    };
  }

  sendCommand(
    workspaceId: string,
    sessionId: string,
    command: unknown
  ): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (
      runtime == null ||
      runtime.workspaceId !== workspaceId ||
      runtime.state.status === "stopped" ||
      runtime.state.status === "error"
    ) {
      return false;
    }
    if (runtime.process.stdin == null || runtime.process.stdin.destroyed) {
      return false;
    }
    const payload = `${serializeCommand(command)}\n`;
    try {
      runtime.process.stdin.write(payload);
      return true;
    } catch {
      return false;
    }
  }

  stopSession(workspaceId: string, sessionId: string): StopAgentSessionResult {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null) {
      return {
        success: true,
        state: buildStoppedState(workspaceId, sessionId),
      };
    }
    return this.stopSessionById(sessionId);
  }

  applyStatePatch(
    workspaceId: string,
    sessionId: string,
    patch: Partial<AgentSessionSnapshot>
  ): AgentSessionSnapshot {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null || runtime.workspaceId !== workspaceId) {
      return {
        ...buildStoppedState(workspaceId, sessionId),
        ...patch,
      };
    }

    runtime.state = {
      ...runtime.state,
      ...patch,
    };
    return { ...runtime.state };
  }

  private stopSessionById(sessionId: string): StopAgentSessionResult {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null) {
      return { success: true, state: buildStoppedState("", sessionId) };
    }

    runtime.state = {
      ...runtime.state,
      status: "stopping",
      stoppedAt: new Date().toISOString(),
    };
    this.options.emitStateUpdated(runtime.workspaceId, runtime.sessionId, {
      ...runtime.state,
    });
    killWithEscalation(runtime.process);

    return {
      success: true,
      state: { ...runtime.state },
    };
  }

  private handleStdout(
    sessionId: string,
    chunk: string,
    onReady: () => void
  ): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null) {
      return;
    }

    // Drain complete lines first, then trim only the incomplete tail: trimming
    // before draining slices an in-flight JSON line and loses the whole record.
    const drained = drainLines(runtime.stdoutBuffer + chunk);
    runtime.stdoutBuffer = trimBuffer(drained.rest);
    if (runtime.stdoutBuffer.length < drained.rest.length) {
      // The in-flight line exceeded the cap and will fail to parse: a lost
      // agent event, so be loud.
      console.error(
        `[CLI] ${sessionId}: NDJSON line exceeded ${MAX_BUFFER_SIZE} bytes and was head-truncated; the event will be dropped.`
      );
    }

    for (const line of drained.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        console.error(
          `[CLI] ${sessionId}: dropping undecodable NDJSON line (${trimmed.length} chars): ${trimmed.slice(0, 200)}…`
        );
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed == null ||
        typeof (parsed as { type?: unknown }).type !== "string"
      ) {
        continue;
      }
      const desktopEvent = parsed as DesktopEvent;
      this.options.emitNdjson(
        runtime.workspaceId,
        runtime.sessionId,
        desktopEvent
      );

      // The agent's own account of the run, for the log dump. Transcript text
      // is filtered out in describeAgentEvent: it is the user's, and enormous.
      const described = describeAgentEvent(runtime.sessionId, desktopEvent);

      if (described != null) logStore().append("agent", described);

      if (desktopEvent.type === "ready") {
        // A ready after a startup timeout must not resurrect the session.
        if (runtime.startupFailed) {
          continue;
        }
        onReady();
        this.reportSpawnResultOnce(runtime.sessionId);
        this.updateRuntimeState(runtime.sessionId, {
          status: "running",
          error: null,
          model: desktopEvent.model,
          mode: parseMode(desktopEvent.mode),
          agentStatus: AgentStatus.Idle,
        });
        this.options.emitSystemReady(runtime.workspaceId, runtime.sessionId);
        // The CLI does not emit `mcp_servers` on ready unasked.
        this.sendCommand(runtime.workspaceId, runtime.sessionId, {
          type: "mcp_list_servers",
        });
      } else if (desktopEvent.type === "mcp_servers") {
        this.applyMcpServersSnapshot(runtime, desktopEvent.servers);
      } else if (desktopEvent.type === "mcp_server_status") {
        this.applyMcpServerStatus(runtime, desktopEvent);
      } else if (desktopEvent.type === "mcp_server_log") {
        this.applyMcpServerLog(runtime, desktopEvent);
      } else if (desktopEvent.type === "mcp_server_logs") {
        // Replace tail wholesale on explicit fetch.
        runtime.mcpLogs.set(desktopEvent.serverId, [...desktopEvent.entries]);
      } else if (desktopEvent.type === "host_service_request") {
        // Not awaited: a render takes seconds and the stdout pump must keep
        // draining, or the agent's events queue up behind the reply.
        void this.answerHostService(
          runtime.workspaceId,
          runtime.sessionId,
          desktopEvent
        );
      } else if (desktopEvent.type === "mcp_refresh_failed") {
        this.options.emitMcpRuntimeError(
          runtime.workspaceId,
          runtime.sessionId,
          {
            kind: "refresh",
            error: desktopEvent.error,
            ts: new Date().toISOString(),
          }
        );
      } else if (desktopEvent.type === "mcp_restart_failed") {
        this.options.emitMcpRuntimeError(
          runtime.workspaceId,
          runtime.sessionId,
          {
            kind: "restart",
            serverId: desktopEvent.serverId,
            error: desktopEvent.error,
            ts: new Date().toISOString(),
          }
        );
      }
    }
  }

  /** Replace the per-session MCP snapshot from a full `mcp_servers` event. */
  private applyMcpServersSnapshot(
    runtime: CliRuntime,
    servers: CliMcpServerSnapshot[]
  ): void {
    const previous = new Map(runtime.mcpServers);
    runtime.mcpServers.clear();
    for (const s of servers) {
      const next = snapshotFromCli(s);
      runtime.mcpServers.set(s.id, next);
      logMcpOutcome(runtime.sessionId, previous.get(s.id), next);
    }
    this.options.emitMcpRuntimeServers(runtime.workspaceId, runtime.sessionId, [
      ...runtime.mcpServers.values(),
    ]);
  }

  /** Merge a status transition into the per-session MCP snapshot. */
  private applyMcpServerStatus(
    runtime: CliRuntime,
    evt: CliMcpStatusEvent & { type: string }
  ): void {
    const prev = runtime.mcpServers.get(evt.serverId);
    const next: AgentMcpServer = {
      id: evt.serverId,
      // Status events only ship the transition fields; keep the rest.
      name: prev?.name ?? evt.serverId,
      transport: prev?.transport ?? "unknown",
      // A transient status event must not clobber a known toolCount, or a
      // brief reconnect reads 0 tools until the next full snapshot.
      toolCount: prev?.toolCount ?? 0,
      status: evt.status,
      updatedAt: evt.ts,
      ...(evt.error != null ? { error: evt.error } : {}),
      ...(evt.authUrl != null ? { authUrl: evt.authUrl } : {}),
      ...(evt.pid != null ? { pid: evt.pid } : {}),
      ...(prev?.connectedAt != null ? { connectedAt: prev.connectedAt } : {}),
    };
    if (evt.status === "connected") {
      next.connectedAt = evt.ts;
    }
    runtime.mcpServers.set(evt.serverId, next);
    logMcpOutcome(runtime.sessionId, prev, next);
    this.options.emitMcpRuntimeStatus(runtime.workspaceId, runtime.sessionId, {
      serverId: evt.serverId,
      status: evt.status,
      ts: evt.ts,
      ...(evt.error != null ? { error: evt.error } : {}),
      ...(evt.authUrl != null ? { authUrl: evt.authUrl } : {}),
      ...(evt.pid != null ? { pid: evt.pid } : {}),
    });
  }

  /** Append a log entry to the per-server tail (capped). */
  private applyMcpServerLog(
    runtime: CliRuntime,
    entry: CliMcpLogEntry & { type: string }
  ): void {
    const stripped: AgentMcpLogEntry = {
      serverId: entry.serverId,
      source: entry.source,
      level: entry.level,
      line: entry.line,
      ts: entry.ts,
      ...(entry.logger != null ? { logger: entry.logger } : {}),
    };
    const tail = runtime.mcpLogs.get(entry.serverId) ?? [];
    tail.push(stripped);
    while (tail.length > MCP_LOG_TAIL_PER_SERVER) tail.shift();
    runtime.mcpLogs.set(entry.serverId, tail);
    this.options.emitMcpRuntimeLog(
      runtime.workspaceId,
      runtime.sessionId,
      stripped
    );
  }

  getMcpServers(workspaceId: string, sessionId: string): AgentMcpServer[] {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null || runtime.workspaceId !== workspaceId) return [];
    return [...runtime.mcpServers.values()];
  }

  getMcpServerLogs(
    workspaceId: string,
    sessionId: string,
    serverId: string
  ): AgentMcpLogEntry[] {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null || runtime.workspaceId !== workspaceId) return [];
    return [...(runtime.mcpLogs.get(serverId) ?? [])];
  }

  /** File an exited session's evidence, oldest dropped first. */
  private recordExit(record: ExitedRuntimeRecord): void {
    this.exited.push(record);
    if (this.exited.length > MAX_EXITED_RECORDS) {
      this.exited.splice(0, this.exited.length - MAX_EXITED_RECORDS);
    }
  }

  /**
   * What each agent this run looks like from here, for the log dump. Dead
   * sessions come first: the stderr of a child that died on startup exists
   * nowhere else.
   */
  getRuntimeDiagnostics(): Array<{
    workspaceId: string;
    sessionId: string;
    state: AgentSessionSnapshot;
    stderr: string;
    mcpServers: AgentMcpServer[];
    command: string;
    mcpLogs: Array<{ serverId: string; entries: AgentMcpLogEntry[] }>;
    live: boolean;
  }> {
    return [
      ...this.exited.map((record) => ({ ...record, live: false })),
      ...[...this.runtimes.values()].map((runtime) => ({
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
        state: { ...runtime.state },
        stderr: runtime.stderrBuffer,
        mcpServers: [...runtime.mcpServers.values()],
        command: runtime.command,
        mcpLogs: [...runtime.mcpLogs.entries()].map(([serverId, entries]) => ({
          serverId,
          entries: [...entries],
        })),
        live: true,
      })),
    ];
  }

  /**
   * Runs a host service for the agent and sends the answer back. Never throws:
   * the agent is blocked on a reply, so a failure travels as `ok: false`.
   */
  private async answerHostService(
    workspaceId: string,
    sessionId: string,
    request: { requestId: string; service: HostService; payload: unknown }
  ): Promise<void> {
    try {
      const result = await this.options.runHostService(
        request.service,
        request.payload
      );

      this.sendCommand(workspaceId, sessionId, {
        type: "host_service_response",
        requestId: request.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      this.sendCommand(workspaceId, sessionId, {
        type: "host_service_response",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Send a command to every running session; returns how many were queued. */
  broadcastCommand(command: DesktopCommand): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.state.status !== "running" &&
        runtime.state.status !== "starting"
      )
        continue;
      if (this.sendCommand(runtime.workspaceId, runtime.sessionId, command))
        count++;
    }
    return count;
  }

  /** Mark a spawn's outcome finalized so a failure is logged at most once. */
  private reportSpawnResultOnce(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime != null) {
      runtime.spawnResultReported = true;
    }
  }

  private updateRuntimeState(
    sessionId: string,
    patch: Partial<AgentSessionSnapshot>
  ): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime == null) {
      return;
    }

    runtime.state = {
      ...runtime.state,
      ...patch,
    };
    this.options.emitStateUpdated(runtime.workspaceId, runtime.sessionId, {
      ...runtime.state,
    });
  }
}
