/**
 * "Use from the web": this desktop serves the AbacusAI Bot web app's coding
 * view for its own signed-in account, so sessions, terminals and files run
 * here, on the user's machine, while they code from a browser.
 *
 * Off unless the user turns it on. When on and signed in, the app keeps one
 * outbound connection to the web app's gateway (`<app host>/bot/runner`),
 * authenticated with the app's own API key; the gateway only ever pairs it
 * with browser tabs signed into the same account. When a tab opens the
 * coding view, the gateway asks for a tunnel and this app opens one more
 * outbound connection (`/bot/runner/data`) and serves the same router its
 * own windows use over it, limited to RUNNER_PROCEDURES. Nothing listens on
 * a port here, so it works behind any NAT or firewall.
 */
import { RPCHandler } from "@orpc/server/ws";
import WebSocket from "ws";

import type { WebRunnerState } from "#shared/contract";
import { ALL_CAPABILITIES } from "#shared/contract";

import type { RpcContext } from "../../rpc/context";
import type { RpcDeps } from "../../rpc/deps";
import { rpcHandlerOptions } from "../../rpc/handler-options";
import { procedurePolicyInterceptor } from "../../rpc/procedure-policy";
import { tabHost, tabWindows } from "../../rpc/remote-tab";
import type { AppRouter } from "../../rpc/router";
import {
  credentialFor,
  readWebRunnerEnabled,
  setWebRunnerEnabled,
} from "../config/settings";
import { abacusAppHost, abacusUserAgent } from "./abacus-host";
import { RUNNER_PROCEDURES } from "./web-runner-policy";

/** Keeps idle proxies from closing the control connection. */
const PING_MS = 25_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** After the gateway refused the key: no point retrying every few seconds. */
const RETRY_REFUSED_MS = 5 * 60_000;

/** The coding view sees a coding machine: no notch, updater or devices. */
const RUNNER_CAPABILITIES = {
  ...ALL_CAPABILITIES,
  routines: false,
  messaging: false,
  browser: false,
  devices: false,
  voice: false,
  localModels: false,
  customMcp: false,
  skillsInstall: false,
  providerKeys: false,
  signIn: false,
  update: false,
  notch: false,
};

export interface WebRunnerOptions {
  router: () => AppRouter;
  /** The desktop's own deps; the tunnel serves a tab-shaped view of them. */
  deps: () => RpcDeps | null;
  publish: (state: WebRunnerState) => void;
}

const gatewayUrl = (path: string): string => {
  const url = new URL(path, abacusAppHost());
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
};

export class WebRunner {
  private control: WebSocket | null = null;
  private readonly tunnels = new Set<WebSocket>();
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  private status: WebRunnerState["status"] = "off";
  private handler: RPCHandler<RpcContext> | null = null;
  private nextTabId = -1;

  constructor(private readonly options: WebRunnerOptions) {}

  state(): WebRunnerState {
    return {
      enabled: readWebRunnerEnabled(),
      status: this.status,
      views: this.tunnels.size,
    };
  }

  setEnabled(enabled: boolean): WebRunnerState {
    setWebRunnerEnabled(enabled);
    if (enabled) this.connect();
    else this.disconnect("off");
    return this.state();
  }

  /** At startup and whenever the stored key changes. */
  refresh(): void {
    this.disconnect(readWebRunnerEnabled() ? "connecting" : "off");
    if (readWebRunnerEnabled()) this.connect();
  }

  dispose(): void {
    this.disconnect("off");
  }

  private setStatus(status: WebRunnerState["status"]): void {
    this.status = status;
    this.options.publish(this.state());
  }

  private key(): string {
    return credentialFor("ABACUS_API_KEY");
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.key()}`,
      "user-agent": abacusUserAgent(),
    };
  }

  private connect(): void {
    if (this.control != null || !readWebRunnerEnabled()) return;
    if (this.key().length === 0) {
      this.setStatus("signed-out");
      return;
    }
    this.clearRetry();
    this.setStatus("connecting");
    const control = new WebSocket(gatewayUrl("/bot/runner"), {
      headers: this.headers(),
    });
    this.control = control;

    control.on("open", () => {
      this.retryMs = RETRY_MIN_MS;
      this.setStatus("connected");
      this.pingTimer = setInterval(() => control.ping(), PING_MS);
    });
    control.on("message", (data) => {
      const message = parseMessage(data);
      if (message?.type === "open" && typeof message.channel === "string")
        this.openTunnel(message.channel);
    });
    control.on("unexpected-response", (_request, response) => {
      const refused =
        response.statusCode === 401 || response.statusCode === 403;
      control.terminate();
      this.lost(refused ? "unavailable" : "connecting", refused);
    });
    control.on("error", (error) => {
      console.warn("[web-runner] connection failed:", error.message);
    });
    control.on("close", () => {
      if (this.control === control) this.lost("connecting", false);
    });
  }

  private lost(status: WebRunnerState["status"], refused: boolean): void {
    if (this.pingTimer != null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.control = null;
    if (!readWebRunnerEnabled()) {
      this.setStatus("off");
      return;
    }
    this.setStatus(status);
    const delay = refused ? RETRY_REFUSED_MS : this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private disconnect(status: WebRunnerState["status"]): void {
    this.clearRetry();
    if (this.pingTimer != null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const control = this.control;
    this.control = null;
    control?.close();
    for (const tunnel of this.tunnels) tunnel.close();
    this.tunnels.clear();
    this.setStatus(status);
  }

  /** One coding view: an outbound socket serving the router to that tab. */
  private openTunnel(channel: string): void {
    const deps = this.options.deps();
    if (deps == null) return;
    const url = new URL(gatewayUrl("/bot/runner/data"));
    url.searchParams.set("channel", channel);
    const tunnel = new WebSocket(url, { headers: this.headers() });
    tunnel.on("open", () => {
      this.tunnels.add(tunnel);
      this.options.publish(this.state());
      this.handler ??= new RPCHandler<RpcContext>(this.options.router(), {
        ...rpcHandlerOptions(),
        clientInterceptors: [
          ...rpcHandlerOptions().clientInterceptors,
          procedurePolicyInterceptor(RUNNER_PROCEDURES),
        ],
      });
      void this.handler.upgrade(tunnel, {
        context: {
          transport: "websocket",
          // Negative: never one of this app's own webContents ids.
          webContentsId: this.nextTabId--,
          windowKind: "remote",
          deps: {
            ...deps,
            host: tabHost(deps.host),
            windows: tabWindows(deps.windows),
            capabilities: () => RUNNER_CAPABILITIES,
            webRunner: undefined,
          },
        },
      });
    });
    tunnel.on("error", (error) => {
      console.warn("[web-runner] tunnel failed:", error.message);
    });
    tunnel.on("close", () => {
      if (this.tunnels.delete(tunnel)) this.options.publish(this.state());
    });
  }
}

const parseMessage = (
  data: WebSocket.RawData
): { type?: unknown; channel?: unknown } | null => {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    return parsed != null && typeof parsed === "object"
      ? (parsed as { type?: unknown; channel?: unknown })
      : null;
  } catch {
    return null;
  }
};
