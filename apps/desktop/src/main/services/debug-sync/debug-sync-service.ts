/**
 * Debug-sync service: electron wiring around `debug-sync.core`. Copies each
 * session's transcript to the Abacus server after every persisted turn, with
 * debounce, retry/backoff, an on-disk marker and a startup sweep. Runs only
 * with an `abacusaibot` key, the sole identity an upload can be attributed to.
 */
import fs from "fs";
import path from "path";

import { app } from "electron";

import { PROVIDER_ENV_VARS } from "#shared/settings";

import { abacusBotHome } from "../../paths";
import { readSettings } from "../config/settings";
import { clientEnvironment } from "../diagnostics/client-environment";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import type { StoredTranscript } from "../session/transcript-service";
import {
  emptySyncState,
  syncStateFromCount,
  syncTranscriptWithRetry,
  shouldSync,
  type SyncDeps,
  type SyncState,
} from "./debug-sync.core";
import { deviceId } from "./device-id";

const DEBOUNCE_MS = 1_500;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2_000;
const MARKER_FILE = (): string =>
  path.join(abacusBotHome(), "debug-sync-state.json");
const TRANSCRIPTS_DIR = (): string => path.join(abacusBotHome(), "transcripts");

interface DebugSyncOptions {
  readTranscript: (sessionId: string) => StoredTranscript | null;
  clientVersion: string;
}

export class DebugSyncService {
  private readonly readTranscript: (id: string) => StoredTranscript | null;
  private readonly clientVersion: string;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  /** sessionId -> what the server holds; a bare count is an older marker. */
  private markers: Record<string, SyncState | number> = {};
  /**
   * Set on the first permanent failure (4xx), after which the service stays
   * quiet for the run; otherwise every new turn would re-enqueue an upload
   * against an endpoint that will not appear mid-run.
   */
  private disabledForRun: string | null = null;

  constructor(options: DebugSyncOptions) {
    this.readTranscript = options.readTranscript;
    this.clientVersion = options.clientVersion;
    this.markers = this.loadMarkers();
  }

  /** Debounced; safe to call on every transcript write. */
  enqueue(sessionId: string): void {
    if (!this.enabled()) return;
    const existing = this.timers.get(sessionId);
    if (existing != null) clearTimeout(existing);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.run(sessionId);
      }, DEBOUNCE_MS)
    );
  }

  /** Upload anything past its marker: offline turns, crashes. Best-effort. */
  sweepOnStartup(): void {
    if (!this.enabled()) return;
    let ids: string[];
    try {
      ids = fs
        .readdirSync(TRANSCRIPTS_DIR())
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length));
    } catch {
      return; // no transcripts dir yet
    }
    for (const sessionId of ids) {
      const transcript = this.readTranscript(sessionId);
      if (shouldSync(transcript, this.syncState(sessionId)))
        this.enqueue(sessionId);
    }
  }

  private enabled(): boolean {
    if (this.disabledForRun != null) return false;
    const settings = readSettings();
    const toggle = settings.serverDebugSync ?? true; // default on
    const key = settings.apiKeys?.[PROVIDER_ENV_VARS.abacus];
    return toggle && (key ?? "").trim().length > 0;
  }

  /** An absent or malformed marker means resync from 0. */
  private syncState(sessionId: string): SyncState {
    const marker = this.markers[sessionId];
    if (typeof marker === "number")
      return syncStateFromCount(this.readTranscript(sessionId), marker);
    if (
      typeof marker === "object" &&
      marker != null &&
      typeof marker.next === "number" &&
      typeof marker.sequences === "object" &&
      marker.sequences != null
    )
      return marker;
    return emptySyncState();
  }

  /** The sequence the server holds a segment under, once it is uploaded. */
  sequenceOf(sessionId: string, segmentId: string): number | null {
    const sequence = this.syncState(sessionId).sequences[segmentId];
    return typeof sequence === "number" ? sequence : null;
  }

  private deps(): SyncDeps {
    return {
      readKey: () => readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus],
      syncUrl: () => this.syncUrl(),
      readTranscript: this.readTranscript,
      readSyncState: (id) => this.syncState(id),
      clientMeta: () => ({
        clientVersion: this.clientVersion,
        deviceId: deviceId(),
        environment: clientEnvironment(),
      }),
      log: (message) => console.log(message),
    };
  }

  /** `<routellm base>/abacusaibot_debug_sync`, with a dev-only localhost override. */
  private syncUrl(): string {
    const override = (process.env.ABACUSAI_BOT_DEBUG_SYNC_URL ?? "").trim();
    if (override.length > 0 && !app.isPackaged) return override;
    return `${abacusRoutellmV1()}/abacusaibot_debug_sync`;
  }

  /**
   * Upload whatever is pending for the session now, and wait for it: a
   * rating is keyed on the synced transcript, so it must land first. A
   * debounced upload still pending is folded in.
   */
  async flush(sessionId: string): Promise<void> {
    const pending = this.timers.get(sessionId);
    if (pending != null) {
      clearTimeout(pending);
      this.timers.delete(sessionId);
    }
    await this.run(sessionId);
  }

  private async run(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) {
      // A newer turn arrived mid-upload; re-arm.
      this.enqueue(sessionId);
      return;
    }
    const current = this.readTranscript(sessionId);
    if (!shouldSync(current, this.syncState(sessionId))) return;

    this.inFlight.add(sessionId);
    try {
      const outcome = await syncTranscriptWithRetry(this.deps(), sessionId, {
        maxAttempts: MAX_ATTEMPTS,
        baseBackoffMs: BASE_BACKOFF_MS,
      });
      if (outcome.status === "ok") {
        this.markers[sessionId] = outcome.state;
        this.saveMarkers();
      } else if (outcome.status === "error") {
        if (!outcome.retryable) {
          this.disabledForRun = outcome.reason;
          console.warn(
            `[debug-sync] disabled for this run (${outcome.reason}). Sync is best-effort and this will not succeed by retrying`
          );
        } else {
          console.warn(
            `[debug-sync] gave up on ${sessionId}: ${outcome.reason}`
          );
        }
      }
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private loadMarkers(): Record<string, SyncState | number> {
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
      console.error("[debug-sync] failed to persist markers", error);
    }
  }
}
