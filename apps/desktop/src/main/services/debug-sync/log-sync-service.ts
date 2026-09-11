/**
 * Log-sync service: electron wiring around `log-sync.core`. Sweeps the
 * per-day log files and ships each one's delta past a byte-offset marker,
 * batched. Logs are scrubbed where written. Success is never logged: that
 * line would grow the `main` stream and re-trigger a sync every sweep.
 */
import fs from "fs";
import path from "path";

import { app } from "electron";

import { PROVIDER_ENV_VARS } from "#shared/settings";

import { abacusBotHome } from "../../paths";
import { readSettings } from "../config/settings";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import { deviceId } from "./device-id";
import {
  completeLines,
  syncLogBatchWithRetry,
  type LogChunk,
  type LogSyncDeps,
} from "./log-sync.core";

const SWEEP_INTERVAL_MS = 120_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2_000;
const MAX_BATCH_BYTES = 40 * 1024 * 1024;
const MAX_FILES_PER_BATCH = 50;
const MARKER_FILE = (): string =>
  path.join(abacusBotHome(), "log-sync-state.json");
const LOGS_DIR = (): string => path.join(abacusBotHome(), "logs");
const LOG_FILE_RE = /^(main|renderer|agent)-(\d{4}-\d{2}-\d{2})\.log$/;

export class LogSyncService {
  /** `<stream>-<day>` -> bytes already synced for that file. */
  private markers: Record<string, number> = {};
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  private disabledForRun: string | null = null;

  constructor() {
    this.markers = this.loadMarkers();
  }

  /** Catch up on what is on disk, then sweep on a timer. */
  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private enabled(): boolean {
    if (this.disabledForRun != null) return false;
    const settings = readSettings();
    const toggle = settings.serverDebugSync ?? true; // default on
    const key = settings.apiKeys?.[PROVIDER_ENV_VARS.abacus];
    return toggle && (key ?? "").trim().length > 0;
  }

  private deps(): LogSyncDeps {
    return {
      readKey: () => readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus],
      syncUrl: () => this.syncUrl(),
      deviceId: () => deviceId(),
    };
  }

  private syncUrl(): string {
    const override = (process.env.ABACUSAI_BOT_LOG_SYNC_URL ?? "").trim();
    if (override.length > 0 && !app.isPackaged) return override;
    return `${abacusRoutellmV1()}/abacusaibot_log_sync`;
  }

  private async sweep(): Promise<void> {
    if (!this.enabled() || this.syncing) return;
    let names: string[];
    try {
      names = fs.readdirSync(LOGS_DIR());
    } catch {
      return; // no logs dir yet
    }

    const deltas: LogChunk[] = [];
    for (const name of names) {
      const match = LOG_FILE_RE.exec(name);
      if (match == null) continue;
      const [, stream, day] = match;
      const marker = this.markers[`${stream}-${day}`] ?? 0;
      const content = this.readTail(path.join(LOGS_DIR(), name), marker);
      if (content != null)
        deltas.push({ stream, day, offset: marker, content });
    }
    if (deltas.length === 0) return;

    this.syncing = true;
    try {
      for (const batch of this.batchBySize(deltas)) {
        const outcome = await syncLogBatchWithRetry(this.deps(), batch, {
          maxAttempts: MAX_ATTEMPTS,
          baseBackoffMs: BASE_BACKOFF_MS,
        });
        if (outcome.status === "ok") {
          for (const result of outcome.results)
            this.markers[`${result.stream}-${result.day}`] = result.stored;
          this.saveMarkers();
        } else if (outcome.status === "error") {
          if (!outcome.retryable) {
            this.disabledForRun = outcome.reason;
            console.warn(
              `[log-sync] disabled for this run (${outcome.reason}) — best-effort, will not succeed by retrying`
            );
          } else {
            console.warn(`[log-sync] batch gave up: ${outcome.reason}`);
          }
          return; // the next sweep retries from the persisted markers
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  /** Greedily pack deltas into batches within the byte and file-count caps. */
  private batchBySize(deltas: LogChunk[]): LogChunk[][] {
    const batches: LogChunk[][] = [];
    let current: LogChunk[] = [];
    let currentBytes = 0;
    for (const delta of deltas) {
      const bytes = Buffer.byteLength(delta.content, "utf-8");
      if (
        current.length > 0 &&
        (currentBytes + bytes > MAX_BATCH_BYTES ||
          current.length >= MAX_FILES_PER_BATCH)
      ) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(delta);
      currentBytes += bytes;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  /** Complete new lines past `marker`, reading only the tail; null if none. */
  private readTail(filePath: string, marker: number): string | null {
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return null;
    }
    if (size <= marker) return null; // nothing new, or the file rotated
    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch {
      return null;
    }
    try {
      const length = size - marker;
      const tail = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, tail, 0, length, marker);
      return completeLines(read < length ? tail.subarray(0, read) : tail);
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  private loadMarkers(): Record<string, number> {
    try {
      return JSON.parse(fs.readFileSync(MARKER_FILE(), "utf-8"));
    } catch {
      return {};
    }
  }

  private saveMarkers(): void {
    try {
      const tmp = `${MARKER_FILE()}.tmp`;
      fs.mkdirSync(path.dirname(MARKER_FILE()), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.markers), "utf-8");
      fs.renameSync(tmp, MARKER_FILE());
    } catch (error) {
      console.error("[log-sync] failed to persist markers", error);
    }
  }
}
