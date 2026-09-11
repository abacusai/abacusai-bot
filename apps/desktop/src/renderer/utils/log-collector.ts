// Renderer half of the log dump (main/services/diagnostics/log-dump.ts). Tees
// console lines into a buffer for `Dump logs` and ships them to main a second
// at a time, since a crashed renderer takes its buffer with it.

const MAX_ENTRIES = 5000;

interface LogEntry {
  timestamp: number;
  level: string;
  args: string;
}

const logBuffer: LogEntry[] = [];
let installed = false;

let unsent: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = 1000;

// Guarded: the bridge is absent in tests and early startup, and a logger that
// throws replaces the error with itself.
function flush(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (unsent.length === 0) return;

  const batch = unsent;

  unsent = [];
  try {
    void window.api?.appendLogs?.(batch);
  } catch {
    // Nowhere to say so.
  }
}

function serialize(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      // JSON.stringify on an Error gives "{}": message/stack are non-enumerable.
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

/** Later calls are no-ops. */
export function installLogCollector(): void {
  if (installed) return;
  installed = true;

  // A reload or close must not strand the last second of logs.
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);

  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      const text = serialize(args);

      logBuffer.push({ timestamp: Date.now(), level, args: text });
      if (logBuffer.length > MAX_ENTRIES) {
        logBuffer.splice(0, logBuffer.length - MAX_ENTRIES);
      }
      unsent.push(`[${level.toUpperCase()}] ${text}`);
      flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
      original(...args);
    };
  }
}

export function getLogDump(): string {
  return logBuffer
    .map(
      (entry) =>
        `[${new Date(entry.timestamp).toISOString()}] [RENDERER] [${entry.level.toUpperCase()}] ${entry.args}`
    )
    .join("\n");
}
