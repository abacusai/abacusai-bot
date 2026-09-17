/**
 * The log dump: everything a bug report needs in one file the user can
 * attach: recent console lines of both processes, each agent process, the
 * spawn environment, and a usage summary. Never config.json or credentials,
 * and everything runs through `scrub` because the file is written to share.
 */
import fs from "node:fs";
import path from "node:path";

import type {
  AbacusAccountInfo,
  AgentMcpLogEntry,
  AgentMcpServer,
  AgentSessionSnapshot,
  UsageSnapshot,
} from "#shared/contracts";

import {
  clientEnvironment,
  formatClientEnvironment,
  type ClientEnvironment,
} from "./client-environment";
import { scrub } from "./scrub";

/** Console lines kept per process. Roughly a few MB at worst. */
const MAX_LOG_ENTRIES = 5000;

const STDERR_TAIL_CHARS = 20_000;

/** Enough to see a handshake fail. */
const MCP_LOG_LINES = 40;

type LogEntry = { timestamp: number; level: string; args: string };

const mainLogBuffer: LogEntry[] = [];

function serializeArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      // message/stack are non-enumerable: JSON.stringify(Error) gives "{}".
      if (arg instanceof Error)
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * Tee main-process console output. Call once, as early as possible: anything
 * printed before this cannot be recovered.
 */
export function installMainLogCollector(sink?: (line: string) => void): void {
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      const text = serializeArgs(args);

      mainLogBuffer.push({
        timestamp: Date.now(),
        level,
        args: text,
      });
      sink?.(`[${level.toUpperCase()}] ${text}`);
      if (mainLogBuffer.length > MAX_LOG_ENTRIES) {
        mainLogBuffer.splice(0, mainLogBuffer.length - MAX_LOG_ENTRIES);
      }
      try {
        original(...args);
      } catch {
        // The console's stream is gone (a closed parent terminal); the
        // buffer and the file sink above already have the line.
      }
    };
  }
}

function formatEntries(entries: LogEntry[], tag: string): string {
  return entries
    .map(
      (entry) =>
        `[${new Date(entry.timestamp).toISOString()}] [${tag}] [${entry.level.toUpperCase()}] ${entry.args}`
    )
    .join("\n");
}

/** Everything the main process has logged since startup. */
export function getMainLogDump(): string {
  return formatEntries(mainLogBuffer, "MAIN");
}

/** What the desktop knows about one agent process it spawned. */
export interface AgentSessionDiagnostics {
  sessionId: string;
  workspaceId: string;
  label: string | null;
  state: AgentSessionSnapshot;
  /** The agent's own session id and log file, when it has reported them. */
  agentSessionId: string | null;
  agentSessionFile: string | null;
  stderrTail: string;
  mcpServers: AgentMcpServer[];
  /** Where a server that never connected says why. */
  mcpLogs: Array<{ serverId: string; entries: AgentMcpLogEntry[] }>;
  /** Exactly what was executed, interpreter included. */
  command: string;
  live: boolean;
}

/**
 * The machine, as far as a spawn is concerned. None of it is secret; PATH is
 * scrubbed of the user's name with the rest of the dump.
 */
export interface EnvironmentInfo {
  client: ClientEnvironment;
  execPath: string;
  resourcesPath: string;
  shell: string;
  pathVar: string;
  agentEntry: string;
  agentEntryExists: boolean;
  /** Directories the packaged agent needs, and whether each one arrived. */
  bundledPaths: Array<{ path: string; exists: boolean; entries?: number }>;
  artifactError: string | null;
}

export interface LogDumpInput {
  appVersion: string;
  isPackaged: boolean;
  homeDir: string;
  rendererLogs: string;
  sessions: AgentSessionDiagnostics[];
  environment: EnvironmentInfo;
  /** Days of log files shipped alongside this summary in the bundle. */
  retainedDays?: number;
  /** Null when the usage scan failed; `usageError` takes its place. */
  usage: UsageSnapshot | null;
  usageError?: string | null;
  /** Null when there is no Abacus key, or the account could not be read. */
  account?: AbacusAccountInfo | null;
}

/**
 * Pure Node so it is testable without a running app. Every probe is guarded:
 * a dump is most needed where something is already missing, and a throw here
 * would take the whole file with it.
 */
export function collectEnvironmentInfo(input: {
  resourcesPath: string;
  agentEntry: string;
  artifactError?: string | null;
}): EnvironmentInfo {
  const exists = (target: string): { exists: boolean; entries?: number } => {
    try {
      const stat = fs.statSync(target);

      return stat.isDirectory()
        ? { exists: true, entries: fs.readdirSync(target).length }
        : { exists: true };
    } catch {
      return { exists: false };
    }
  };

  const agentRoot = path.dirname(input.agentEntry);

  return {
    client: clientEnvironment(),
    execPath: process.execPath,
    resourcesPath: input.resourcesPath,
    // An empty COMSPEC is how a Windows shell spawn ends up with no shell.
    shell:
      process.platform === "win32"
        ? `COMSPEC=${process.env.COMSPEC ?? "(unset)"}`
        : `SHELL=${process.env.SHELL ?? "(unset)"}`,
    pathVar: process.env.PATH ?? "(unset)",
    agentEntry: input.agentEntry,
    agentEntryExists: exists(input.agentEntry).exists,
    bundledPaths: [agentRoot, path.join(agentRoot, "node_modules")].map(
      (target) => ({ path: target, ...exists(target) })
    ),
    artifactError: input.artifactError ?? null,
  };
}

function formatSession(session: AgentSessionDiagnostics): string {
  const { state } = session;
  const lines = [
    `--- ${session.label ?? "Untitled"} (${session.sessionId})${session.live ? "" : " [exited]"} ---`,
    `workspace: ${session.workspaceId}`,
    `command: ${session.command}`,
    `status: ${state.status}  agentStatus: ${state.agentStatus}  pid: ${state.pid ?? "-"}`,
    `model: ${state.model ?? "-"}  mode: ${state.mode ?? "-"}`,
    `started: ${state.startedAt ?? "-"}  stopped: ${state.stoppedAt ?? "-"}  exit: ${state.exitCode ?? "-"}`,
    `error: ${state.error ?? "-"}`,
    `agent session: ${session.agentSessionId ?? "-"}`,
    `agent log: ${session.agentSessionFile ?? "-"}`,
  ];

  if (session.mcpServers.length > 0) {
    lines.push("mcp servers:");
    for (const server of session.mcpServers) {
      lines.push(
        `  ${server.name} (${server.id}) ${server.transport} ${server.status} tools=${server.toolCount}${server.error != null ? ` error=${server.error}` : ""}`
      );
    }
  }

  for (const server of session.mcpLogs) {
    const entries = server.entries.slice(-MCP_LOG_LINES);

    if (entries.length === 0) continue;

    lines.push(`mcp log ${server.serverId}:`);
    for (const entry of entries) {
      lines.push(
        `  [${entry.ts}] [${entry.source}/${entry.level}] ${entry.line}`
      );
    }
  }

  lines.push(
    session.stderrTail.length > 0
      ? `stderr tail:\n${session.stderrTail}`
      : "stderr tail: (empty)"
  );

  return lines.join("\n");
}

function formatEnvironment(env: EnvironmentInfo): string {
  const lines = [
    formatClientEnvironment(env.client),
    `electron binary: ${env.execPath}`,
    `resources: ${env.resourcesPath}`,
    `shell: ${env.shell}`,
    `agent entry: ${env.agentEntry} ${env.agentEntryExists ? "(present)" : "(MISSING)"}`,
  ];

  if (env.artifactError != null) {
    lines.push(`artifact resolver: ${env.artifactError}`);
  }

  for (const entry of env.bundledPaths) {
    lines.push(
      `bundled: ${entry.path} ${entry.exists ? `(present${entry.entries != null ? `, ${entry.entries} entries` : ""})` : "(MISSING)"}`
    );
  }

  // Last and on its own line: the longest value here.
  lines.push(`PATH: ${env.pathVar}`);

  return lines.join("\n");
}

/**
 * The usage numbers as the panel shows them. A row with tokens and no cost
 * is the shape of a pricing bug and is invisible in "my usage looks wrong".
 */
function formatUsage(
  usage: UsageSnapshot | null,
  error?: string | null
): string {
  if (usage == null) {
    return `(usage unavailable${error != null ? `: ${error}` : ""})`;
  }

  const lines = [
    `window: ${usage.days}d  requests: ${usage.totals.requests}  errors: ${usage.totals.errors}  cost: ${usage.totals.cost}${usage.unpriced ? " (a row moved tokens at an unknown price)" : ""}`,
  ];

  for (const model of usage.models) {
    lines.push(
      `  ${model.id}  req=${model.requests} err=${model.errors} in=${model.input} out=${model.output} cost=${model.cost} billing=${model.billing}${model.pool ? " pool" : ""}`
    );
  }

  return lines.join("\n");
}

/**
 * Plan and credits. Every out-of-credits report so far has cost a round trip
 * asking which tier the user is on and whether the balance is spent; the
 * usage numbers above say what was billed, not what the account is allowed.
 */
function formatAccount(account: AbacusAccountInfo | null | undefined): string {
  if (account == null)
    return "(not signed in to Abacus.AI, or the account read failed)";

  const credits =
    account.credits_granted == null
      ? "credits: unknown"
      : `credits: ${account.credits_used ?? 0} used of ${account.credits_granted} granted`;

  return [
    `plan: ${account.plan ?? "unknown"}  tier: ${account.subscription_tier ?? "unknown"}`,
    credits,
  ].join("\n");
}

export function buildLogDump(input: LogDumpInput): string {
  const header = [
    "AbacusAIBot log dump",
    `generated: ${new Date().toISOString()}`,
    `version: ${input.appVersion}${input.isPackaged ? "" : " (development build)"}`,
    `electron: ${process.versions.electron}  node: ${process.versions.node}  chrome: ${process.versions.chrome}`,
    `home: ${input.homeDir}`,
    "",
    input.retainedDays != null
      ? `logs/: the last ${input.retainedDays} days, one file per day per stream.`
      : "",
    "",
    "No configuration or credentials are included, and API keys, tokens and the",
    "user's name are redacted from everything here and in logs/.",
  ].join("\n");

  const sessions =
    input.sessions.length > 0
      ? input.sessions.map(formatSession).join("\n\n")
      : "(no agent sessions this run)";

  return scrub(
    [
      header,
      "",
      "=== ENVIRONMENT ===",
      formatEnvironment(input.environment),
      "",
      "=== ACCOUNT ===",
      formatAccount(input.account),
      "",
      "=== USAGE ===",
      formatUsage(input.usage, input.usageError),
      "",
      "=== AGENT SESSIONS ===",
      sessions,
      "",
      "=== MAIN PROCESS LOGS ===",
      getMainLogDump(),
      "",
      "=== RENDERER PROCESS LOGS ===",
      input.rendererLogs,
      "",
    ].join("\n"),
    input.homeDir
  );
}

/** Keep only the useful end of a child's stderr. */
export function tailStderr(buffer: string): string {
  return buffer.length <= STDERR_TAIL_CHARS
    ? buffer
    : buffer.slice(-STDERR_TAIL_CHARS);
}
