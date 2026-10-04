import type { Transport } from "#renderer/data/transport";

const MAX_ENTRIES = 5000;
const lines: string[] = [];
const serialize = (args: unknown[]) =>
  args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error)
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    })
    .join(" ");

/** A bounded renderer log tee, with the legacy diagnostics dump format. */
export const installLogRing = (transport: Transport): (() => void) => {
  const logs = transport.client.system.logs;
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length) void logs.append({ lines: batch }).catch(() => undefined);
  };
  const restore: Array<() => void> = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    const original = console[level];
    const tee = (...args: unknown[]) => {
      const text = serialize(args);
      lines.push(
        `[${new Date().toISOString()}] [RENDERER] [${level.toUpperCase()}] ${text}`
      );
      if (lines.length > MAX_ENTRIES)
        lines.splice(0, lines.length - MAX_ENTRIES);
      pending.push(`[${level.toUpperCase()}] ${text}`);
      if (pending.length > MAX_ENTRIES)
        pending.splice(0, pending.length - MAX_ENTRIES);
      timer ??= setTimeout(flush, 1000);
      original.apply(console, args);
    };
    console[level] = tee;
    restore.push(() => {
      if (console[level] === tee) console[level] = original;
    });
  }
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  return () => {
    restore.forEach((undo) => undo());
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("beforeunload", flush);
    flush();
  };
};
export const getLogDump = (): string => lines.join("\n");
