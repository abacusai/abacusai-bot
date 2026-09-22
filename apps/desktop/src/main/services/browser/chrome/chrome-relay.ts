/**
 * The other end of the Playwright Extension: a loopback WebSocket the
 * extension connects to once the user allows it, over which this app drives
 * the tabs the extension puts in its tab group. The wire protocol is the
 * extension's — `chrome.debugger.*` and `chrome.tabs.*` calls with positional
 * arguments, and the same APIs' events coming back — so the app speaks CDP to
 * a real Chrome tab exactly as it does to its own view.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

/** The protocol the connect page accepts; older extensions refuse a newer one. */
export const EXTENSION_PROTOCOL_VERSION = 2;

/** What the extension knows about a tab, as `chrome.tabs.Tab`. */
export interface ChromeTabInfo {
  id: number;
  url?: string;
  title?: string;
  active?: boolean;
  openerTabId?: number;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface ChromeRelayEvents {
  /** The user allowed the connection and the initial tab is attached. */
  ready: [];
  /** A tab the debugger is attached to raised a CDP event. */
  cdpEvent: [tabId: number, method: string, params: unknown];
  tabAttached: [tab: ChromeTabInfo];
  tabDetached: [tabId: number];
  tabRemoved: [tabId: number];
  /** The extension went away, with the close reason. */
  disconnected: [reason: string];
}

const CONNECT_WAIT_MS = 5 * 60_000;

export class ChromeRelay extends EventEmitter<ChromeRelayEvents> {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly path = `/extension/${randomUUID()}`;
  private socket: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private initialized = false;
  /** Tabs the extension has told us about, attached or not. */
  private readonly tabs = new Map<number, ChromeTabInfo>();
  private readonly attached = new Set<number>();
  private waiters: Array<(error?: Error) => void> = [];

  /** Listen on a loopback port; the URL the extension must open comes from `connectUrl`. */
  async listen(): Promise<void> {
    if (this.server != null) return;
    const server = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== this.path) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    this.server = server;
    this.wss = wss;
  }

  get listening(): boolean {
    return this.server != null;
  }

  get connected(): boolean {
    return this.socket != null && this.initialized;
  }

  /** The `chrome-extension://` page that asks the user to allow this client. */
  connectUrl(extensionId: string, clientName: string, token?: string): string {
    const url = new URL(`chrome-extension://${extensionId}/connect.html`);
    url.searchParams.set(
      "mcpRelayUrl",
      `ws://127.0.0.1:${this.port}${this.path}`
    );
    url.searchParams.set("client", JSON.stringify({ name: clientName }));
    url.searchParams.set("protocolVersion", String(EXTENSION_PROTOCOL_VERSION));
    if (token != null && token.length > 0) url.searchParams.set("token", token);
    return url.toString();
  }

  /** Resolves once the extension is connected and initialised, or rejects when it is not by `timeoutMs`. */
  waitForConnection(timeoutMs = CONNECT_WAIT_MS): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== settle);
        reject(new Error("the browser did not connect in time"));
      }, timeoutMs);
      const settle = (error?: Error): void => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      this.waiters.push(settle);
    });
  }

  attachedTabs(): ChromeTabInfo[] {
    return [...this.attached]
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is ChromeTabInfo => tab != null);
  }

  tab(tabId: number): ChromeTabInfo | undefined {
    return this.tabs.get(tabId);
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  /** A new tab in the client's group, attached and ready for CDP. */
  async createTab(url: string): Promise<ChromeTabInfo> {
    const tab = (await this.send("chrome.tabs.create", [{ url }])) as
      | ChromeTabInfo
      | undefined;
    if (tab?.id == null) throw new Error("Chrome did not create a tab");
    this.tabs.set(tab.id, tab);
    await this.attach(tab.id);
    return tab;
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    await this.send("chrome.debugger.attach", [{ tabId }, "1.3"]);
    this.attached.add(tabId);
    const tab = this.tabs.get(tabId) ?? { id: tabId };
    this.tabs.set(tabId, tab);
    this.emit("tabAttached", tab);
  }

  async closeTab(tabId: number): Promise<void> {
    await this.send("chrome.tabs.remove", [tabId]);
  }

  /** A CDP command on one attached tab. */
  cdp(
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    return this.send("chrome.debugger.sendCommand", [
      { tabId },
      method,
      params,
    ]);
  }

  /** Drop the extension and stop listening. */
  close(reason = "closed"): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, reason);
    this.failPending(new Error(reason));
    this.wss?.close();
    this.server?.close();
    this.wss = null;
    this.server = null;
    this.initialized = false;
    this.tabs.clear();
    this.attached.clear();
    for (const waiter of this.waiters.splice(0)) waiter(new Error(reason));
  }

  private accept(ws: WebSocket): void {
    if (this.socket != null) {
      ws.close(1000, "another extension connection is already open");
      return;
    }
    this.socket = ws;
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", (_code, reason) =>
      this.onClose(reason.toString() || "closed")
    );
    ws.on("error", (error) => this.onClose(error.message));
  }

  private onClose(reason: string): void {
    if (this.socket == null) return;
    this.socket = null;
    this.initialized = false;
    this.failPending(new Error(`the browser disconnected: ${reason}`));
    const attached = Array.from(this.attached);
    this.attached.clear();
    for (const tabId of attached) this.emit("tabDetached", tabId);
    this.tabs.clear();
    for (const waiter of this.waiters.splice(0))
      waiter(new Error(`the browser disconnected: ${reason}`));
    this.emit("disconnected", reason);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(method: string, params: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (socket == null || socket.readyState !== socket.OPEN)
      return Promise.reject(new Error("the browser is not connected"));
    const id = ++this.nextId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown[];
      result?: unknown;
      error?: string | { message?: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (pending == null) return;
      this.pending.delete(message.id);
      if (message.error != null) {
        pending.reject(
          new Error(
            typeof message.error === "string"
              ? message.error
              : (message.error.message ?? "the browser refused the command")
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const params = message.params ?? [];
    switch (message.method) {
      case "chrome.tabs.onCreated": {
        const tab = params[0] as ChromeTabInfo | undefined;
        if (tab?.id == null) return;
        this.tabs.set(tab.id, tab);
        // Before the handshake ends this is the tab the user picked, and the
        // extension attaches it for us on request; after, a popup opened by
        // one of ours, which it also expects us to claim.
        void this.attach(tab.id).catch(() => undefined);
        return;
      }
      case "chrome.tabs.onRemoved": {
        const tabId = params[0] as number;
        this.tabs.delete(tabId);
        if (this.attached.delete(tabId)) this.emit("tabDetached", tabId);
        this.emit("tabRemoved", tabId);
        return;
      }
      case "chrome.debugger.onDetach": {
        const source = params[0] as { tabId?: number } | undefined;
        if (source?.tabId != null && this.attached.delete(source.tabId))
          this.emit("tabDetached", source.tabId);
        return;
      }
      case "chrome.debugger.onEvent": {
        const [source, method, cdpParams] = params as [
          { tabId?: number; sessionId?: string },
          string,
          unknown,
        ];
        // Child sessions (workers, out-of-process frames) carry a sessionId;
        // the page's own events do not, and those are the ones the tools read.
        if (source?.tabId == null || source.sessionId != null) return;
        this.emit("cdpEvent", source.tabId, method, cdpParams);
        return;
      }
      case "extension.initialized": {
        this.initialized = true;
        for (const waiter of this.waiters.splice(0)) waiter();
        this.emit("ready");
        return;
      }
      default:
        return;
    }
  }
}
