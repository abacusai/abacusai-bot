/**
 * Diagnostics-sync service: uploads a secret-free snapshot of this install
 * (OS, versions, model, key presence, toggles, MCP server ids, connector
 * states) so a synced log can be read against it. Never a key, token, or message
 * content. Success is not logged: it would grow the `main` log.
 */
import { app } from "electron";

import { PROVIDER_ENV_VARS } from "#shared/settings";

import { readSettings, storedKeyProviders } from "../config/settings";
import {
  clientEnvironment,
  safely,
  type ClientEnvironment,
} from "../diagnostics/client-environment";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import { deviceId } from "./device-id";

const INITIAL_DELAY_MS = 8_000; // let MCP/messaging services initialize first
const INTERVAL_MS = 300_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface McpServerSummary {
  id: string;
  isBuiltin: boolean;
  disabled: boolean;
}

interface ConnectorSummary {
  name: string;
  state: string;
  isConnected: boolean;
}

/** The outcome, not the config. */
export interface McpRuntimeSummary {
  id: string;
  status: string;
  toolCount: number;
  error?: string;
}

export interface DiagnosticsSyncDeps {
  /** Ids only, never the config: it holds auth. */
  mcpServers: () => McpServerSummary[];
  mcpRuntime: () => McpRuntimeSummary[];
  connectors: () => ConnectorSummary[];
  fetchImpl?: typeof fetch;
}

interface DiagnosticsSnapshot extends ClientEnvironment {
  app_version: string;
  is_packaged: boolean;
  versions: { electron?: string; node?: string; chrome?: string };
  model: string | null;
  provider: string | null;
  configured_providers: string[];
  toggles: Record<string, boolean | null>;
  exec_backend: string | null;
  mcp_servers: McpServerSummary[];
  mcp_runtime: McpRuntimeSummary[];
  connectors: ConnectorSummary[];
}

export class DiagnosticsSyncService {
  private timer: NodeJS.Timeout | null = null;
  private disabledForRun: string | null = null;
  /** JSON of the last snapshot sent this run; an identical one is skipped. */
  private lastSent: string | null = null;

  constructor(private readonly deps: DiagnosticsSyncDeps) {}

  start(): void {
    setTimeout(() => void this.capture(), INITIAL_DELAY_MS).unref?.();
    this.timer = setInterval(() => void this.capture(), INTERVAL_MS);
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

  private syncUrl(): string {
    const override = (
      process.env.ABACUSAI_BOT_DIAGNOSTICS_SYNC_URL ?? ""
    ).trim();
    if (override.length > 0 && !app.isPackaged) return override;
    return `${abacusRoutellmV1()}/abacusaibot_diagnostics_sync`;
  }

  private snapshot(): DiagnosticsSnapshot {
    const settings = readSettings();
    const model = settings.defaultModel ?? null;
    const versions = process.versions as Record<string, string | undefined>;
    return {
      ...clientEnvironment(),
      app_version: app.getVersion(),
      is_packaged: app.isPackaged,
      versions: {
        electron: versions.electron,
        node: versions.node,
        chrome: versions.chrome,
      },
      model,
      provider: model ? (model.split("/")[0] ?? null) : null,
      configured_providers: safely(() => storedKeyProviders(), []),
      toggles: {
        serverDebugSync: settings.serverDebugSync ?? true,
        autoDefaultMode:
          settings.defaultMode == null ? null : settings.defaultMode === "AUTO",
        notificationsDisabled: settings.notificationsDisabled ?? null,
      },
      exec_backend: settings.execBackend ?? null,
      mcp_servers: safely(() => this.deps.mcpServers(), []),
      mcp_runtime: safely(() => this.deps.mcpRuntime(), []),
      connectors: safely(() => this.deps.connectors(), []),
    };
  }

  private async capture(): Promise<void> {
    if (!this.enabled()) return;
    const key = readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus];
    if (key == null || key.trim().length === 0) return;

    const snapshot = this.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSent) return; // unchanged since the last successful send

    const doFetch = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await doFetch(this.syncUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ device_id: deviceId(), snapshot }),
        signal: controller.signal,
      });
      if (resp.ok) {
        this.lastSent = json;
      } else if (resp.status >= 400 && resp.status < 500) {
        this.disabledForRun = `http ${resp.status}`;
        console.warn(
          `[diagnostics-sync] disabled for this run (http ${resp.status}). Best-effort, will not succeed by retrying`
        );
      }
      // 5xx: lastSent stays unset so the next interval retries.
    } catch {
      // Transient; the next interval retries.
    } finally {
      clearTimeout(timer);
    }
  }
}
