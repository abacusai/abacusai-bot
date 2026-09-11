/**
 * Logs that outlive the run that wrote them: one file per day per stream
 * under `<home>/logs`, five days kept, all shipped in the dump. Writes are
 * buffered and flushed on a timer because this runs on the main thread.
 * Scrubbed on the way in, not out: these files sit on disk for days.
 */
import fs from "node:fs";
import path from "node:path";

import { abacusBotHome } from "#main/paths";

import { scrub } from "./scrub";

/** Today inclusive. */
export const RETENTION_DAYS = 5;

/** Past it the day's file stops growing. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const FLUSH_INTERVAL_MS = 1000;

/** Each stream is its own file so one can be read without the others. */
export type LogStream = "main" | "renderer" | "agent";

const STREAMS: LogStream[] = ["main", "renderer", "agent"];

/** `YYYY-MM-DD` in local time, the day a reader would call it. */
export const dayKey = (at: Date = new Date()): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

const fileName = (stream: LogStream, day: string): string =>
  `${stream}-${day}.log`;

/** Null for anything in the directory that is not a log file. */
export const dayOfFile = (name: string): string | null => {
  const match = name.match(
    /^(?:main|renderer|agent)-(\d{4}-\d{2}-\d{2})\.log$/
  );

  return match?.[1] ?? null;
};

export class LogStore {
  private readonly pending = new Map<LogStream, string[]>();
  private readonly written = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private day = dayKey();
  /**
   * Nothing is written until start(): the store is a module singleton, and a
   * unit test must not append to the user's real log directory.
   */
  private started = false;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  start(): void {
    this.started = true;
    this.day = dayKey(this.now());
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // Survivable: the in-memory buffers still feed the dump.
    }
    this.prune();
  }

  /** Never throws: a logger that can take the app down is worse than none. */
  append(stream: LogStream, line: string): void {
    if (!this.started) return;

    const at = this.now();
    const today = dayKey(at);

    // Rollover: yesterday's buffered lines belong to yesterday's file.
    if (today !== this.day) {
      this.flush();
      this.day = today;
      this.prune();
    }

    const queue = this.pending.get(stream) ?? [];

    queue.push(`[${at.toISOString()}] ${line}`);
    this.pending.set(stream, queue);
    this.schedule();
  }

  /** Called on the timer, on quit, and before a dump. */
  flush(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    for (const [stream, lines] of this.pending) {
      this.pending.set(stream, []);

      if (lines.length === 0) continue;

      const target = path.join(this.dir, fileName(stream, this.day));
      const payload = `${scrub(lines.join("\n"))}\n`;
      const already = this.written.get(target) ?? this.sizeOf(target);

      if (already >= MAX_FILE_BYTES) continue;

      try {
        fs.appendFileSync(
          target,
          already + payload.length > MAX_FILE_BYTES
            ? `${payload.slice(0, Math.max(0, MAX_FILE_BYTES - already))}\n[log capped for the day]\n`
            : payload
        );
        this.written.set(target, already + payload.length);
      } catch {
        // Disk full, permissions, a home that vanished: the run continues.
      }
    }
  }

  /** Oldest first. */
  files(): Array<{ name: string; path: string }> {
    this.flush();

    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => dayOfFile(name) != null)
        .sort()
        .map((name) => ({ name, path: path.join(this.dir, name) }));
    } catch {
      return [];
    }
  }

  prune(): void {
    const cutoff = new Date(this.now());

    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (RETENTION_DAYS - 1));

    const oldest = dayKey(cutoff);

    let names: string[];

    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    for (const name of names) {
      const day = dayOfFile(name);

      // String comparison is date comparison for ISO days; a stray file is
      // not this code's to delete.
      if (day == null || day >= oldest) continue;

      try {
        fs.unlinkSync(path.join(this.dir, name));
        this.written.delete(path.join(this.dir, name));
      } catch {
        // Locked by a reader on Windows; it will go on the next rollover.
      }
    }
  }

  private sizeOf(target: string): number {
    try {
      return fs.statSync(target).size;
    } catch {
      return 0;
    }
  }

  private schedule(): void {
    if (this.timer != null) return;

    this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    // Must not hold the process open at quit; the quit path flushes.
    this.timer.unref?.();
  }
}

export const LOG_STREAMS = STREAMS;

let shared: LogStore | null = null;

/** Created on first use so a test can point HOME elsewhere first. */
export const logStore = (): LogStore => {
  shared ??= new LogStore(path.join(abacusBotHome(), "logs"));

  return shared;
};
