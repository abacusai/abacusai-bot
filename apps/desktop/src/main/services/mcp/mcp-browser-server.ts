import fs from "fs";
import http from "http";
import net from "net";
import path from "path";

import { sendToRenderer } from "#main/renderer-host";
import { IpcChannels } from "#shared/channels";
import type { ConversationKey } from "#shared/conversation-scope";

import { abacusBotHome } from "../../paths";
import {
  chooseOption,
  globToRegexSource,
  isSyntaxError,
  navigationRefusal,
  navigationSettled,
  numericArg,
  parseKeyCombo,
  planExecuteAttempts,
  recipeFor,
  resolveTarget,
  SnapshotStore,
  type TargetResolution,
} from "../browser/browser-actions";
import {
  checkScript,
  clickScript,
  extractScript,
  fillScript,
  selectScript,
  settleScript,
  typeScript,
  valueScript,
} from "../browser/browser-page-scripts";
import {
  diffRefs,
  extractRefMap,
  filterSnapshot,
  formatOverlays,
  formatPageSummary,
  formatTree,
  GET_ELEMENT_CENTER_JS,
  PAGE_SUMMARY_JS,
  renderTree,
  SNAPSHOT_BUILD_JS,
  type PageSummary,
  type SnapshotNode,
  type SnapshotOverlay,
} from "../browser/browser-snapshot";
import {
  pickBrowserTarget,
  type BrowserPage,
  type BrowserTargetMemory,
  type BrowserTargetSource,
} from "../browser/browser-target";
import { localMcpServerToken } from "./mcp-config-service";

interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const NAVIGATE_TIMEOUT_MS = 20_000;
const WEBVIEW_ATTACH_TIMEOUT_MS = 15_000;
// The wait after a first attach timeout: long enough for a pane the renderer
// is opening, short enough that a session that can never have one answers fast.
const ATTACH_RETRY_GRACE_MS = 2_000;
// How long a `goto` insists on seeing the view leave before settling on the
// host check alone; a `goto` to the page already open never goes loading.
const NAVIGATE_START_GRACE_MS = 1_500;
// Shorter than a `goto` deadline: history moves go somewhere already visited.
const HISTORY_NAVIGATE_TIMEOUT_MS = 10_000;

/**
 * Said with a way out: a bare "unavailable" reads as bad luck and the model
 * retries through attach timeouts when `web_fetch` would have done in a second.
 */
const NO_BROWSER =
  "The browser preview is not available right now. Do not retry in a loop. " +
  "To read a public page use `web_fetch` with the URL, or `web_search` to find one — " +
  "neither needs a browser. Only if the task truly requires a browser (a signed-in app, " +
  "a form to fill) tell the user the browser pane did not open and ask them to try again.";
const SERVER_NAME = "browser";
const SERVER_VERSION = "2.1.0";
const TEMP_DIR = path.join(abacusBotHome(), "temp");

const TOOLS_SCHEMA: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  browser_navigate: {
    description: [
      "Navigate the browser. goto loads a URL; back, forward and reload move through history.",
      "",
      "Put the query in the URL whenever the site allows it — one goto replaces a dozen clicks:",
      "  google.com/travel/flights?q=Flights from BLR to DEL on 2026-09-20 one way",
      "  google.com/maps/search/coffee+near+me   ·   amazon.in/s?k=usb+c+cable",
      "",
      "The result already lists the page's clickable elements with @eN refs, so you can act",
      "right away without a separate snapshot.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["goto", "back", "forward", "reload"],
          description: 'Navigation action; a call with only a url is a "goto"',
        },
        url: {
          type: "string",
          description: 'URL to navigate to (required for "goto")',
        },
      },
      required: [],
    },
  },
  browser_snapshot: {
    description: [
      "Read the page. Every element you can act on has an @eN ref that stays the same",
      "for as long as the element is on the page.",
      "",
      'snapshot   — the element tree. Add find:"Delhi" to list only elements whose label',
      "             matches, or interactive_only:true to drop plain text. Prefer find over",
      "             reading a whole tree.",
      "extract    — structured rows without writing JavaScript: selector (required), optional",
      '             fields {"price": ".price"} mapping names to selectors inside each row, limit.',
      "             A <table> comes back as rows of cells.",
      "screenshot — an image of the viewport plus a short description of where the page is.",
      "text       — visible text, optionally scoped by selector.",
      "url / title — just that.",
      'find       — shorthand for snapshot with find:"..." (same result).',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "snapshot",
            "extract",
            "screenshot",
            "text",
            "url",
            "title",
            "find",
          ],
          description: "What to read",
        },
        find: {
          type: "string",
          description:
            'snapshot only: list only elements whose label, placeholder or value contains this text (e.g. "Add to cart")',
        },
        interactive_only: {
          type: "boolean",
          description: "snapshot only: leave out plain text nodes",
        },
        selector: {
          type: "string",
          description:
            'CSS selector: the rows for "extract" (required there), or the region for "text"',
        },
        fields: {
          type: "object",
          description:
            'extract only: column name → selector inside each row, e.g. {"title":"h2","price":".a-price"}',
          additionalProperties: { type: "string" },
        },
        limit: {
          type: "number",
          description: "extract only: maximum rows (default 25, max 100)",
        },
      },
      required: ["action"],
    },
  },
  browser_interact: {
    description: [
      "Act on an element by its @eN ref. After the action the result says what changed —",
      "new elements with their refs, a new URL, a dialog that appeared — so you rarely need",
      "another snapshot. Refs stay valid while the element exists.",
      "",
      "click        — click (params: ref)",
      "fill         — replace a field's text (params: ref, text)",
      "pick         — fill an autocomplete and choose the matching suggestion from its dropdown,",
      "               then confirm the field took it (params: ref, text). Use this for city,",
      "               airport, product and address boxes — plain fill leaves them unchanged.",
      "type         — append text without clearing (params: ref, text)",
      "select       — choose an option in a <select> (params: ref, value — option text works)",
      "press        — a key or combo (params: key, e.g. Enter, Escape, ArrowDown, Control+a)",
      "dismiss      — close the cookie banner, consent dialog or overlay on top of the page",
      "check / uncheck — a checkbox (params: ref)",
      "hover, focus, scroll_into_view — (params: ref)",
      "scroll       — the page or an element (params: direction, amount, optional ref)",
      "wait         — until text appears, a URL matches, or an element exists",
      "               (params: text | url_pattern | ref, amount = timeout ms). Use this instead",
      "               of snapshotting in a loop while results load.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "click",
            "fill",
            "pick",
            "type",
            "select",
            "press",
            "dismiss",
            "hover",
            "scroll",
            "scroll_into_view",
            "focus",
            "check",
            "uncheck",
            "wait",
          ],
          description: "Interaction action",
        },
        ref: {
          type: "string",
          description:
            'Element ref from a snapshot or a previous result, e.g. "@e3"',
        },
        selector: {
          type: "string",
          description:
            "Advanced: a CSS selector instead of a ref. Only when no ref exists for the element.",
        },
        text: {
          type: "string",
          description:
            "Text for fill/pick/type, or the text to wait for in wait",
        },
        value: {
          type: "string",
          description: "Option value or label for select",
        },
        key: {
          type: "string",
          description:
            'Key for press, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a"',
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction",
        },
        amount: {
          type: "number",
          description:
            "Scroll pixels (default 500) or wait timeout ms (default 5000)",
        },
        url_pattern: {
          type: "string",
          description: 'URL glob pattern for wait, e.g. "**/results**"',
        },
      },
      required: ["action"],
    },
  },
  browser_execute: {
    description: [
      "Run JavaScript in the page and return the result. For anything browser_snapshot extract",
      "cannot express: shadow roots, iframes, computed styles. A bare expression is returned",
      "as-is; `return` also works.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript code to execute. Runs inside an async function; a bare expression or a return statement both work.",
        },
      },
      required: ["code"],
    },
  },
};

/** Drop screenshots older than a day — nothing looks at yesterday's page. */
function pruneOldScreenshots(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const file = path.join(TEMP_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        /* raced with another prune, or unreadable — skip */
      }
    }
  } catch {
    /* directory missing; the capture will create it */
  }
}

function summarizeToolCall(
  tool: string,
  args: Record<string, unknown>
): string {
  const a = args ?? {};
  const action = typeof a.action === "string" ? a.action : undefined;
  switch (tool) {
    case "browser_navigate":
      if (action === "goto" && typeof a.url === "string")
        return `Open ${a.url}`;
      return `Navigate (${action ?? "unknown"})`;
    case "browser_snapshot":
      return `Read page state (${action ?? "snapshot"})`;
    case "browser_interact": {
      const target = (a.ref as string) ?? (a.selector as string) ?? "element";
      return `${action ?? "Interact with"} ${target}`;
    }
    case "browser_execute":
      return "Run JavaScript in the page";
    default:
      return tool;
  }
}

/** Pure-read tools; the permission gate skips these to avoid prompt fatigue. */
function isReadOnlyBrowserTool(
  name: string,
  _args: Record<string, unknown>
): boolean {
  return name === "browser_snapshot";
}

export interface McpBrowserServerOptions {
  /** Gate consulted before each tool call; when omitted, nothing is gated. */
  requestPermission?: (
    tool: string,
    summary: string,
    sessionId?: string
  ) => Promise<"allow" | "deny">;
  /** The waits, sized for a cold first launch; tests override them. */
  timeouts?: { attachMs?: number; navigateMs?: number; historyMs?: number };
  /** The browser runtime's views, resolved per call so a late attach counts. */
  target?: () => BrowserTargetSource | null;
  /** The conversation a session's browser belongs to; picks the pane opened. */
  conversationKeyForSession?: (sessionId: string) => ConversationKey | null;
}

export class McpBrowserServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private activeSessions = new Map<
    string,
    { transport: "sse"; res: http.ServerResponse }
  >();
  private sessionCounter = 0;
  /** The last snapshot's refs, per session. See SnapshotStore. */
  private readonly snapshots = new SnapshotStore();

  constructor(private readonly options: McpBrowserServerOptions = {}) {}

  async start(): Promise<number> {
    if (this.server != null) return this.port!;
    const port = await this.findAvailablePort();
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve, reject) => {
      this.server!.listen(port, "127.0.0.1", () => {
        resolve(port);
      });
      this.server!.on("error", reject);
    });
  }

  stop(): void {
    for (const [, session] of this.activeSessions) {
      try {
        session.res.end();
      } catch {
        /* ignore */
      }
    }
    this.activeSessions.clear();
    // Refs, the remembered view and the attach verdict all describe a browser
    // that is about to stop existing.
    this.snapshots.clearAll();
    this.targetMemory.clear();
    this.attachTimedOut.clear();
    if (this.server != null) {
      this.server.close();
      this.server = null;
      this.port = null;
    }
  }

  getPort(): number | null {
    return this.port;
  }
  isRunning(): boolean {
    return this.server != null;
  }

  private async findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on("error", reject);
    });
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

    // No CORS headers: a wildcard origin would let any page the user browsed
    // call tools/call on loopback.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      // Per-boot bearer token from the runtime MCP config; a browser gets 401.
      if (
        req.headers.authorization !==
        `Bearer ${localMcpServerToken(SERVER_NAME)}`
      ) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Unauthorized" },
          })
        );
        return;
      }
      if (req.method === "GET") this.handleSseConnection(res);
      else if (req.method === "POST") this.handleJsonRpcPost(req, res);
      else if (req.method === "DELETE") this.handleSessionDelete(req, res);
      else {
        res.writeHead(405);
        res.end();
      }
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: SERVER_NAME,
          version: SERVER_VERSION,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private handleSseConnection(res: http.ServerResponse): void {
    const sessionId = `session-${++this.sessionCounter}`;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
    this.activeSessions.set(sessionId, { transport: "sse", res });
    res.on("close", () => {
      this.activeSessions.delete(sessionId);
    });
  }

  private handleJsonRpcPost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      // Malformed JSON is a Parse error (-32700); a handler that threw is an
      // Internal error (-32603) carrying the request id and message.
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          })
        );
        return;
      }

      try {
        // The URL carries the session id, which is how a prompt knows whether
        // the asking session is in Bypass mode.
        const agentSessionId =
          new URL(
            req.url ?? "/",
            `http://localhost:${this.port}`
          ).searchParams.get("session") ?? undefined;
        const response = await this.processJsonRpc(request, agentSessionId);
        const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
        const sessionId = url.searchParams.get("sessionId");
        if (sessionId != null && this.activeSessions.has(sessionId)) {
          const session = this.activeSessions.get(sessionId)!;
          try {
            session.res.write(
              `event: message\ndata: ${JSON.stringify(response)}\n\n`
            );
          } catch {
            /* closed */
          }
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        }
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id ?? null,
            error: {
              code: -32603,
              message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
            },
          })
        );
      }
    });
  }

  private handleSessionDelete(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId != null) {
      const session = this.activeSessions.get(sessionId);
      if (session) {
        try {
          session.res.end();
        } catch {
          /* already closed */
        }
        this.activeSessions.delete(sessionId);
      }
    }
    res.writeHead(200);
    res.end();
  }

  private async processJsonRpc(
    request: JsonRpcRequest,
    sessionId?: string
  ): Promise<JsonRpcResponse> {
    const { method, params, id } = request;
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            tools: Object.entries(TOOLS_SCHEMA).map(([name, s]) => ({
              name,
              description: s.description,
              inputSchema: s.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const toolName = (params as any)?.name ?? "";
        const toolArgs = (params as any)?.arguments ?? {};
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: await this.executeTool(toolName, toolArgs, sessionId),
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      default:
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  /** Sessions whose full attach wait already expired; see getWC. */
  private readonly attachTimedOut = new Set<string>();

  private attachKey(sessionId?: string): string {
    return sessionId ?? "";
  }

  /** The view each session settled on, and the last URL it navigated. */
  private readonly targetMemory = new Map<string, BrowserTargetMemory>();

  private memoryFor(sessionId?: string): BrowserTargetMemory {
    const key = sessionId ?? "";
    let memory = this.targetMemory.get(key);
    if (memory == null) {
      memory = { id: null, url: null };
      this.targetMemory.set(key, memory);
    }
    return memory;
  }

  private remember(
    sessionId: string | undefined,
    id: number,
    url?: string
  ): void {
    const memory = this.memoryFor(sessionId);
    memory.id = id;
    if (url != null) memory.url = url;
  }

  /** The session's own view, if the runtime has one alive. */
  private findView(sessionId?: string): BrowserPage | null {
    const source = this.options.target?.() ?? null;
    if (source == null) return null;

    let candidates;
    try {
      candidates = source.candidates();
    } catch {
      return null;
    }
    const memory = this.memoryFor(sessionId);
    const chosen = pickBrowserTarget(candidates, memory, sessionId ?? null);
    if (chosen == null) return null;

    const wc = source.webContents(chosen);
    if (wc == null || wc.isDestroyed()) return null;
    memory.id = wc.id;

    return wc;
  }

  /** Whether the pages are the app's own pane, which the renderer shows and animates. */
  private presentsInApp(): boolean {
    return this.options.target?.()?.presentsInApp !== false;
  }

  private emitPreviewEvent(url?: string, sessionId?: string): void {
    if (!this.presentsInApp()) return;
    const conversationKey =
      sessionId == null
        ? null
        : (this.options.conversationKeyForSession?.(sessionId) ?? null);
    sendToRenderer(IpcChannels.Event, {
      type: "mcp-open-preview",
      url,
      ...(conversationKey == null ? {} : { conversationKey }),
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * Block until the view has finished going somewhere, or the deadline passes.
   * Returns the URL it settled on, or null. `targetHost` is null for history
   * navigation, which has no destination to check.
   */
  private async awaitNavigation(
    wc: BrowserPage,
    startUrl: string,
    targetHost: string | null,
    timeoutMs: number
  ): Promise<string | null> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    // A grace longer than the deadline can never elapse, and the wait would
    // report a failure for a navigation that had arrived.
    const grace = Math.min(NAVIGATE_START_GRACE_MS, timeoutMs / 2);
    // `loadURL` and `goBack` are asynchronous: the first poll can run before
    // the view has begun leaving.
    let sawLoading = false;

    while (Date.now() < deadline) {
      const loading = wc.isLoading();
      if (loading) sawLoading = true;
      const current = wc.getURL();

      if (
        navigationSettled({
          loading,
          currentUrl: current,
          startUrl,
          targetHost,
          sawLoading,
          elapsedMs: Date.now() - startedAt,
          graceMs: grace,
        })
      ) {
        return current;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
  }

  /**
   * Go back, forward, or reload, and report where it ended up. All three are
   * asynchronous, so success is decided by the settled URL, not the call.
   */
  private async historyNavigate(
    wc: BrowserPage,
    what: "back" | "forward" | "reload",
    go: () => void,
    sessionId?: string
  ): Promise<ToolResult> {
    const startUrl = wc.getURL();

    go();

    const landed = await this.awaitNavigation(
      wc,
      startUrl,
      null,
      this.historyTimeout()
    );
    this.onNavigated();

    const done = what === "reload" ? "Page reloaded" : `Navigated ${what}`;

    if (landed == null) {
      return this.ok(
        `${done}, but it had not finished after ${this.historyTimeout() / 1000}s ` +
          `(preview is at ${wc.getURL()}). Snapshot to see where it actually is.`
      );
    }

    return this.ok(await this.arrival(wc, sessionId, `${done} to ${landed}.`));
  }

  /**
   * Drive the preview to a URL and report where it landed. `emitPreviewEvent`
   * and `loadURL` race, and the loser is aborted, so awaiting `loadURL` alone
   * never settles; success is decided by where the webContents ended up.
   */
  private async navigateTo(
    wc: BrowserPage,
    url: string,
    sessionId?: string
  ): Promise<ToolResult> {
    const target = new URL(url);
    const startUrl = wc.getURL();

    this.emitPreviewEvent(url, sessionId);

    // Chromium serves its error page at the URL that failed, so landing on the
    // host proves nothing; only `did-fail-load` knows. ERR_ABORTED (-3) is the
    // normal outcome for the losing racer of two navigations, not a failure.
    let failure: string | null = null;
    const onFailLoad = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      _failedUrl: string,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame && errorCode !== -3) {
        failure = `${errorDescription} (${errorCode})`;
      }
    };
    wc.on("did-fail-load", onFailLoad);

    wc.loadURL(url).catch(() => {
      // Interrupted by the renderer's own navigation to the same URL. Expected.
    });

    const landed = await this.awaitNavigation(
      wc,
      startUrl,
      target.host,
      this.navigateTimeout()
    );
    if (!wc.isDestroyed()) wc.off("did-fail-load", onFailLoad);

    if (failure != null) {
      this.onNavigated();

      return this.err(
        `${url} did not load: ${failure}. The site refused the request or is unreachable — try a different source.`
      );
    }

    if (landed != null) {
      this.onNavigated();
      // Remember both so later calls drive this view, by URL after a remount.
      this.remember(sessionId, wc.id, landed);

      return this.ok(
        await this.arrival(wc, sessionId, `Navigated to ${landed}.`)
      );
    }

    const current = wc.getURL();
    this.onNavigated();

    return this.err(
      `Navigation to ${url} did not complete within ${this.navigateTimeout() / 1000}s (preview is at ${current}). ` +
        "The page may still be loading — take a snapshot to check."
    );
  }

  /**
   * The view this session drives, creating one when it has none. A session
   * gets its own hidden browser from the runtime, so a bot never touches what
   * is on screen; only a caller with no session id uses the renderer's pane.
   */
  private async getWC(
    sessionId?: string,
    navigateUrl?: string
  ): Promise<BrowserPage | null> {
    const attachKey = this.attachKey(sessionId);
    let wc = this.findView(sessionId);
    if (wc != null) {
      this.attachTimedOut.delete(attachKey);

      return wc;
    }

    const source = this.options.target?.() ?? null;
    if (source == null) return null;

    if (sessionId != null) {
      try {
        const id = await source.materialize(
          sessionId,
          navigateUrl ?? "about:blank"
        );
        if (id != null) {
          wc = source.webContents(id);
          if (wc != null && !wc.isDestroyed()) {
            this.remember(sessionId, wc.id);
            this.attachTimedOut.delete(attachKey);

            return wc;
          }
        }
      } catch (error) {
        console.error(
          `[mcp-browser] could not create a browser view for session ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // No session to own a view: ask the renderer for its pane and wait,
    // briefly once it has already failed to appear.
    const grace = this.attachTimedOut.has(attachKey)
      ? Math.min(ATTACH_RETRY_GRACE_MS, this.attachTimeout())
      : this.attachTimeout();

    this.emitPreviewEvent(navigateUrl ?? "about:blank", sessionId);

    const deadline = Date.now() + grace;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      wc = this.findView(sessionId);
      if (wc != null) {
        this.attachTimedOut.delete(attachKey);

        return wc;
      }
    }

    if (!this.attachTimedOut.has(attachKey)) {
      console.error(
        `[mcp-browser] no browser view appeared within ${grace}ms for session ${sessionId ?? "(none)"}`
      );
    }
    this.attachTimedOut.add(attachKey);

    return null;
  }

  private attachTimeout(): number {
    return this.options.timeouts?.attachMs ?? WEBVIEW_ATTACH_TIMEOUT_MS;
  }
  private navigateTimeout(): number {
    return this.options.timeouts?.navigateMs ?? NAVIGATE_TIMEOUT_MS;
  }
  private historyTimeout(): number {
    return this.options.timeouts?.historyMs ?? HISTORY_NAVIGATE_TIMEOUT_MS;
  }

  private async cdp(
    wc: BrowserPage,
    method: string,
    params?: Record<string, unknown>
  ): Promise<any> {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    return wc.debugger.sendCommand(method, params);
  }

  /**
   * Keys the browser needs told about by name and virtual key code; anything
   * absent is a printable character CDP derives from the text.
   */
  private static readonly NAMED_KEYS: Record<
    string,
    { code: string; keyCode: number }
  > = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Space: { code: "Space", keyCode: 32 },
  };

  /** CDP's modifier bitmask. */
  private static modifierMask(mods: string[]): number {
    let mask = 0;
    if (mods.includes("alt")) mask |= 1;
    if (mods.includes("control") || mods.includes("ctrl")) mask |= 2;
    if (mods.includes("meta") || mods.includes("command")) mask |= 4;
    if (mods.includes("shift")) mask |= 8;

    return mask;
  }

  /**
   * Send a key the way the keyboard would: a printable character as `keyDown`
   * with `text`, a named key with its virtual key code so Enter submits.
   */
  private async dispatchTrustedKey(
    wc: BrowserPage,
    key: string,
    mods: string[]
  ): Promise<void> {
    const modifiers = McpBrowserServer.modifierMask(mods);
    const named = McpBrowserServer.NAMED_KEYS[key];
    const isPrintable = named == null && [...key].length === 1;

    if (named == null && !isPrintable) {
      throw new Error(`Unsupported key: ${key}`);
    }

    // A view the user never clicked into is not focused, and input events to
    // it are silently dropped; assert focus or every keystroke goes nowhere.
    wc.focus();

    // A one-shot capture listener, so the check below is about this key.
    await this.evalJS(
      wc,
      `(function() {
      window.__abacusBotKeySeen = undefined;
      // Kept on window so the check below can take it off again: a key that
      // never arrives leaves the listener registered, and one press per failed
      // attempt accumulates on a page the agent keeps trying.
      if (window.__abacusBotKeyProbe) window.removeEventListener('keydown', window.__abacusBotKeyProbe, true);
      const probe = (e) => {
        window.__abacusBotKeySeen = e.key;
        window.removeEventListener('keydown', probe, true);
        window.__abacusBotKeyProbe = undefined;
      };
      window.__abacusBotKeyProbe = probe;
      window.addEventListener('keydown', probe, true);
    })()`
    );

    const base =
      named != null
        ? {
            key,
            code: named.code,
            windowsVirtualKeyCode: named.keyCode,
            nativeVirtualKeyCode: named.keyCode,
          }
        : { key, text: key, unmodifiedText: key };

    await this.cdp(wc, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers,
      ...base,
    });
    await this.cdp(wc, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      ...base,
    });

    // Ask the page whether it saw the key; an unfocused view reports nothing
    // and the caller falls back to synthetic events.
    const delivered = await this.evalJS(
      wc,
      `(function() {
      const seen = window.__abacusBotKeySeen === ${JSON.stringify(key)};
      window.__abacusBotKeySeen = undefined;
      if (window.__abacusBotKeyProbe) {
        window.removeEventListener('keydown', window.__abacusBotKeyProbe, true);
        window.__abacusBotKeyProbe = undefined;
      }
      return seen;
    })()`
    ).catch(() => false);

    if (delivered !== true) throw new Error("Key event was not delivered");
  }

  /** How long an action gets for its consequences to land before they are reported. */
  private static readonly SETTLE_QUIET_MS = 300;
  private static readonly SETTLE_MAX_MS = 2_500;

  private async settle(
    wc: BrowserPage,
    maxMs = McpBrowserServer.SETTLE_MAX_MS
  ): Promise<void> {
    const deadline = Date.now() + maxMs;
    // A click that navigates destroys the page context mid-wait.
    while (wc.isLoading() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const remaining = Math.max(200, deadline - Date.now());
    await this.evalJS(
      wc,
      settleScript(McpBrowserServer.SETTLE_QUIET_MS, remaining)
    ).catch(() => undefined);
  }

  /** A fresh snapshot, with the session's refs replaced by it. */
  private async takeSnapshot(
    wc: BrowserPage,
    sessionId?: string
  ): Promise<{
    title: string;
    url: string;
    tree: SnapshotNode | null;
    refCount: number;
    visibleCount: number;
    offscreenCount: number;
    overlays?: SnapshotOverlay[];
  }> {
    const result = await this.evalJS(wc, SNAPSHOT_BUILD_JS);
    // A reply that is not a snapshot must not wipe the refs the session holds.
    if (result == null || typeof result !== "object") {
      return {
        title: wc.getTitle(),
        url: wc.getURL(),
        tree: null,
        refCount: 0,
        visibleCount: 0,
        offscreenCount: 0,
      };
    }
    const state = this.snapshots.for(sessionId);
    if (result.tree != null) {
      state.refMap.clear();
      extractRefMap(result.tree, state.refMap);
      state.url = typeof result.url === "string" ? result.url : wc.getURL();
    }
    if (typeof result.title !== "string") result.title = wc.getTitle();
    if (typeof result.url !== "string") result.url = wc.getURL();
    if (typeof result.refCount !== "number")
      result.refCount = state.refMap.size;
    if (typeof result.visibleCount !== "number")
      result.visibleCount = result.refCount;
    if (typeof result.offscreenCount !== "number") result.offscreenCount = 0;
    if (!Array.isArray(result.overlays)) result.overlays = [];

    return result;
  }

  private captureBefore(
    wc: BrowserPage,
    sessionId?: string
  ): { url: string; title: string; refs: Map<string, string> } {
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      refs: new Map(this.snapshots.for(sessionId).refMap),
    };
  }

  /** What an action did to the page: URL, new elements with refs, overlays. */
  private async reportChanges(
    wc: BrowserPage,
    sessionId: string | undefined,
    before: { url: string; title: string; refs: Map<string, string> }
  ): Promise<string> {
    await this.settle(wc);

    let result: Awaited<ReturnType<McpBrowserServer["takeSnapshot"]>>;
    try {
      result = await this.takeSnapshot(wc, sessionId);
    } catch {
      return `Now at ${wc.getURL()} — the page is still loading; wait, then snapshot.`;
    }
    if (result.tree == null) return "";

    const lines: string[] = [];
    if (result.url !== before.url) lines.push(`Now at ${result.url}`);
    if (result.title !== before.title && result.title.length > 0)
      lines.push(`Title: ${result.title}`);

    const { added, removed } = diffRefs(before.refs, result.tree);
    const shown = added.slice(0, 15);
    if (shown.length > 0) {
      lines.push(
        `${added.length} new element${added.length === 1 ? "" : "s"}${added.length > shown.length ? ` (first ${shown.length})` : ""}:`
      );
      for (const node of shown)
        lines.push(formatTree({ ...node, children: undefined }, 1));
    }
    if (removed > 0)
      lines.push(`${removed} element${removed === 1 ? "" : "s"} gone`);

    const overlays = formatOverlays(result.overlays);
    if (overlays.length > 0) lines.push(overlays);

    if (lines.length === 0)
      return "Nothing visible changed yet. If results were expected, use interact wait with text or url_pattern.";

    return `Changes:\n${lines.join("\n")}`;
  }

  /** What a page looks like on arrival: its clickable elements and any overlay. */
  private async arrival(
    wc: BrowserPage,
    sessionId: string | undefined,
    headline: string
  ): Promise<string> {
    const lines = [headline];
    const tip = recipeFor(wc.getURL());

    try {
      await this.settle(wc, 1_500);
      const result = await this.takeSnapshot(wc, sessionId);
      if (result.title.length > 0) lines.push(`Page: ${result.title}`);
      const overlays = formatOverlays(result.overlays);
      if (overlays.length > 0) lines.push(overlays);
      const compact = filterSnapshot(
        result.tree,
        { interactiveOnly: true },
        40
      );
      if (compact.count > 0) {
        lines.push(
          `${compact.count} interactive element${compact.count === 1 ? "" : "s"}${compact.count > 40 ? " (first 40)" : ""}:`
        );
        lines.push(compact.text);
        lines.push(
          'Act on these refs directly, or browser_snapshot with find:"..." for anything not listed.'
        );
      } else {
        lines.push(
          "No interactive elements yet — the page may still be loading. Use interact wait, then snapshot."
        );
      }
    } catch {
      lines.push("The page is still loading. Wait, then take a snapshot.");
    }

    if (tip != null) lines.push(`Tip for this site: ${tip}`);

    return lines.join("\n");
  }

  /**
   * Fill an autocomplete and choose from its dropdown in one call; typing
   * alone leaves such a field on its old value.
   */
  private async pick(
    wc: BrowserPage,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const text = typeof args.text === "string" ? args.text : "";
    if (text.trim().length === 0)
      return this.err('"text" is required for pick.');
    const resolved = this.target(args, sessionId);
    if (resolved.kind !== "selector")
      return this.err(
        this.refError(args, this.snapshots.for(sessionId).refMap.size)
      );
    const sel = resolved.selector;
    const label = this.label(args);

    const before = this.captureBefore(wc, sessionId);
    await this.animateCursorToElement(wc, sel).catch(() => {});
    this.animateCursorClick();
    const filled = await this.evalJS(wc, fillScript(sel, text));
    if (filled?.status === "not_found")
      return this.err(this.notFoundError(args, sel));
    if (filled?.status !== "ok" && filled?.status !== "rejected") {
      return this.err(
        `${label} cannot be typed into (${filled?.status ?? "unknown"}). Take a snapshot and aim at the input itself.`
      );
    }
    // Many sites open suggestions on a keystroke, not a value assignment.
    await this.dispatchTrustedKey(wc, "ArrowDown", []).catch(() => {});
    await this.settle(wc);

    let result: Awaited<ReturnType<McpBrowserServer["takeSnapshot"]>>;
    try {
      result = await this.takeSnapshot(wc, sessionId);
    } catch {
      return this.err(
        `Filled ${label}, but the page navigated before a suggestion could be chosen.`
      );
    }
    const { added } = diffRefs(before.refs, result.tree);
    const options = added.filter(
      (node) => node.ref != null && (node.name ?? "").trim().length > 0
    );
    const choice = chooseOption(options, text);

    if (choice?.selector != null) {
      await this.animateCursorToElement(wc, choice.selector).catch(() => {});
      this.animateCursorClick();
      const clicked = await this.evalJS(wc, clickScript(choice.selector)).catch(
        () => null
      );
      if (clicked?.status !== "ok") {
        return this.err(
          `Found suggestion "${choice.name}" but could not click it. Options seen: ${options
            .slice(0, 8)
            .map((node) => `${node.ref} "${node.name}"`)
            .join(", ")}`
        );
      }
    } else {
      // No dropdown surfaced: accept the highlighted suggestion, if any.
      await this.dispatchTrustedKey(wc, "Enter", []).catch(() => {});
    }

    await this.settle(wc);
    const value = String(
      (await this.evalJS(wc, valueScript(sel)).catch(() => "")) ?? ""
    );
    const firstWord = (text.trim().split(/[\s,]+/)[0] ?? "").toLowerCase();
    const took =
      value.length > 0 &&
      (choice != null
        ? value.toLowerCase().includes(firstWord) ||
          (choice.name ?? "")
            .toLowerCase()
            .includes(value.toLowerCase().slice(0, 12))
        : value.toLowerCase().includes(firstWord));

    const changes = await this.reportChanges(wc, sessionId, before);
    const seen =
      options.length > 0
        ? ` Suggestions were: ${options
            .slice(0, 8)
            .map((node) => `${node.ref} "${node.name}"`)
            .join(", ")}.`
        : " No suggestion list appeared.";

    if (!took) {
      return this.err(
        `Typed "${text}" into ${label} but the field reads "${value}" — the site did not accept it.${seen} ` +
          `Click the right suggestion by ref, or try a shorter text.\n${changes}`
      );
    }

    return this.ok(
      `Picked ${choice != null ? `"${choice.name}"` : "the highlighted suggestion"} for ${label}; the field now reads "${value}".\n${changes}`
    );
  }

  /** Close whatever is sitting on top of the page. */
  private async dismiss(
    wc: BrowserPage,
    sessionId?: string
  ): Promise<ToolResult> {
    const before = this.captureBefore(wc, sessionId);
    const result = await this.takeSnapshot(wc, sessionId);
    const overlays = result.overlays ?? [];
    if (overlays.length === 0)
      return this.err(
        "No dialog, banner or overlay is detected on top of the page. If something is in the way, snapshot and click its close button by ref."
      );

    const PREFER =
      /^(accept|agree|allow|got it|ok|okay|continue|i understand|close|dismiss|×|x|no thanks|not now|reject|decline|later)/i;
    const closed: string[] = [];
    for (const overlay of overlays) {
      const button =
        overlay.buttons.find((candidate) => PREFER.test(candidate.name)) ??
        overlay.buttons.find((candidate) =>
          /accept|agree|close|dismiss|ok|reject|decline/i.test(candidate.name)
        ) ??
        overlay.buttons[0];
      if (button == null) continue;
      const selector = this.snapshots.for(sessionId).refMap.get(button.ref);
      if (selector == null) continue;
      const clicked = await this.evalJS(wc, clickScript(selector)).catch(
        () => null
      );
      if (clicked?.status === "ok") closed.push(`"${button.name}"`);
      await this.dispatchTrustedKey(wc, "Escape", []).catch(() => {});
    }
    if (closed.length === 0)
      return this.err(
        `Could not click a button on the overlay. ${formatOverlays(overlays)}`
      );

    const changes = await this.reportChanges(wc, sessionId, before);

    return this.ok(`Dismissed ${closed.join(", ")}.\n${changes}`);
  }

  private async evalJS(wc: BrowserPage, expression: string): Promise<any> {
    const { result, exceptionDetails } = await this.cdp(
      wc,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }
    );
    if (exceptionDetails) {
      throw new Error(
        exceptionDetails.exception?.description ??
          exceptionDetails.text ??
          "JS error"
      );
    }
    return result?.value;
  }

  /**
   * What this call is aimed at, against the last snapshot's refs. `stale-ref`
   * is distinct from `no-target`: an action with a targetless meaning must not
   * quietly act on a different element than the one the caller meant.
   */
  private target(
    args: Record<string, unknown>,
    sessionId?: string
  ): TargetResolution {
    return resolveTarget(args, this.snapshots.for(sessionId).refMap);
  }

  private emitCursorEvent(type: "mcp-cursor-move", x: number, y: number): void;
  private emitCursorEvent(type: "mcp-cursor-click" | "mcp-cursor-hide"): void;
  private emitCursorEvent(type: string, x?: number, y?: number): void {
    if (!this.presentsInApp()) return;
    const payload: Record<string, unknown> = {
      type,
      emittedAt: new Date().toISOString(),
    };
    if (x != null) payload.x = x;
    if (y != null) payload.y = y;
    sendToRenderer(IpcChannels.Event, payload);
  }

  private async animateCursorToElement(
    wc: BrowserPage,
    sel: string
  ): Promise<void> {
    const center = await this.evalJS(wc, GET_ELEMENT_CENTER_JS(sel));
    if (center?.x != null && center?.y != null) {
      this.emitCursorEvent("mcp-cursor-move", center.x, center.y);
      await new Promise((r) => setTimeout(r, 220));
    }
  }

  private animateCursorClick(): void {
    this.emitCursorEvent("mcp-cursor-click");
  }

  private onNavigated(): void {
    // Every session's refs point at the one preview pane; all are invalidated.
    this.snapshots.clearAll();
    this.emitCursorEvent("mcp-cursor-hide");
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    try {
      // Pure-read tools skip the prompt; navigate/interact/execute stay gated.
      if (
        this.options.requestPermission != null &&
        !isReadOnlyBrowserTool(name, args)
      ) {
        const summary = summarizeToolCall(name, args);
        const decision = await this.options.requestPermission(
          name,
          summary,
          sessionId
        );
        if (decision === "deny") {
          return this.err("Browser permission denied by user.");
        }
      }
      const run = (): Promise<ToolResult> => {
        switch (name) {
          case "browser_navigate":
            return this.executeNavigate(args, sessionId);
          case "browser_snapshot":
            return this.executeSnapshot(args, sessionId);
          case "browser_interact":
            return this.executeInteract(args, sessionId);
          case "browser_execute":
            return this.executeExecute(args, sessionId);
          default:
            return Promise.resolve(this.err(`Unknown tool: ${name}`));
        }
      };
      // A call that never returns takes the whole sub-agent run with it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(),
          new Promise<ToolResult>((resolve) => {
            timer = setTimeout(
              () =>
                resolve(
                  this.err(
                    `${name} did not finish within ${McpBrowserServer.CALL_TIMEOUT_MS / 1000}s. ` +
                      "The page may be unresponsive; take a snapshot to see where it is, or navigate again."
                  )
                ),
              McpBrowserServer.CALL_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        if (timer != null) clearTimeout(timer);
      }
    } catch (e) {
      return this.err(e instanceof Error ? e.message : String(e));
    }
  }

  /** How long any one capture attempt gets. A hidden view can leave a CDP screenshot pending forever. */
  private static readonly CAPTURE_TIMEOUT_MS = 5_000;

  /**
   * A picture of the page, or null. `capturePage` with `stayHidden` first,
   * since it paints an off-screen view; the debugger's screenshot is the
   * fallback and hangs on a hidden view.
   */
  private async captureImage(
    wc: BrowserPage
  ): Promise<{ data: string; mimeType: string } | null> {
    const bounded = <T>(work: () => Promise<T>): Promise<T | null> =>
      Promise.race([
        work().catch(() => null),
        new Promise<null>((resolve) =>
          setTimeout(
            () => resolve(null),
            McpBrowserServer.CAPTURE_TIMEOUT_MS
          ).unref?.()
        ),
      ]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const captured = await bounded(() =>
        wc.capturePage(undefined, { stayHidden: true })
      );
      if (captured != null) {
        if (typeof captured.toJPEG === "function") {
          const jpeg = captured.toJPEG(70);
          if (jpeg.length > 0)
            return { data: jpeg.toString("base64"), mimeType: "image/jpeg" };
        }
        const png = captured.toPNG();
        if (png.length > 0)
          return { data: png.toString("base64"), mimeType: "image/png" };
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const viaDebugger = await bounded(() =>
      this.cdp(wc, "Page.captureScreenshot", { format: "jpeg", quality: 70 })
    );
    const data = (viaDebugger as { data?: unknown } | null)?.data;

    return typeof data === "string" && data.length > 0
      ? { data, mimeType: "image/jpeg" }
      : null;
  }

  /** Longest any one tool call may run; `wait` accepts up to two minutes itself. */
  private static readonly CALL_TIMEOUT_MS = 150_000;

  private ok(text: string): ToolResult {
    return { content: [{ type: "text", text }] };
  }
  private err(text: string): ToolResult {
    return { content: [{ type: "text", text }], isError: true };
  }

  private async executeNavigate(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    // A url with no action is a goto; a small model drops the action often.
    const action =
      typeof args.action === "string"
        ? args.action
        : typeof args.url === "string"
          ? "goto"
          : "";
    switch (action) {
      case "goto": {
        const url = args.url as string;
        if (!url) return this.err('URL is required for "goto".');
        const refusal = navigationRefusal(url);
        if (refusal != null) return this.err(refusal);
        const wc = await this.getWC(sessionId, url);
        if (!wc) return this.err(NO_BROWSER);
        return await this.navigateTo(wc, url, sessionId);
      }
      case "back": {
        const wc = await this.getWC(sessionId);
        if (!wc) return this.err(NO_BROWSER);
        // Otherwise goBack() silently does nothing and a move is reported.
        if (!wc.canGoBack()) return this.err("There is no page to go back to.");
        return await this.historyNavigate(
          wc,
          "back",
          () => wc.goBack(),
          sessionId
        );
      }
      case "forward": {
        const wc = await this.getWC(sessionId);
        if (!wc) return this.err(NO_BROWSER);
        if (!wc.canGoForward())
          return this.err("There is no page to go forward to.");
        return await this.historyNavigate(
          wc,
          "forward",
          () => wc.goForward(),
          sessionId
        );
      }
      case "reload": {
        const wc = await this.getWC(sessionId);
        if (!wc) return this.err(NO_BROWSER);
        return await this.historyNavigate(
          wc,
          "reload",
          () => wc.reload(),
          sessionId
        );
      }
      default:
        return this.err(
          `Unknown navigate action: ${action || "(none)"}. Use goto with a url, or back, forward, reload.`
        );
    }
  }

  private async executeSnapshot(
    rawArgs: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    // `find` reads as an action to a model that saw it in the description;
    // it is snapshot with a filter, so treat it as that rather than refuse.
    const args =
      rawArgs.action === "find"
        ? {
            ...rawArgs,
            action: "snapshot",
            find: rawArgs.find ?? rawArgs.text ?? rawArgs.selector ?? "",
          }
        : rawArgs;
    const action = (args.action as string) ?? "";
    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(NO_BROWSER);

    switch (action) {
      case "snapshot": {
        const result = await this.takeSnapshot(wc, sessionId);
        if (!result?.tree || result.refCount === 0) {
          // The walker reads the light DOM, so web components and frames have
          // nothing for it, and querySelector cannot reach into either.
          return this.ok(
            `Page: ${result?.title ?? wc.getTitle()}\nURL: ${result?.url ?? wc.getURL()}\n\n` +
              "(no interactive elements found)\n" +
              'The page may still be loading — interact action:"wait" with text or url_pattern, then snapshot again.\n' +
              "If it stays empty the content is likely inside a shadow root or an iframe, which this snapshot " +
              "and plain document.querySelector both see through: reach it with browser_execute using " +
              "element.shadowRoot or the frame's contentDocument, or navigate straight to the frame URL."
          );
        }
        const lines: string[] = [];
        lines.push(`Page: ${result.title}`);
        lines.push(`URL: ${result.url}`);
        const find = typeof args.find === "string" ? args.find.trim() : "";
        const interactiveOnly = args.interactive_only === true;
        if (find.length > 0 || interactiveOnly) {
          const filtered = filterSnapshot(result.tree, {
            find,
            interactiveOnly,
          });
          lines.push(
            find.length > 0
              ? `${filtered.count} element${filtered.count === 1 ? "" : "s"} matching "${find}":`
              : `${filtered.count} interactive elements:`
          );
          lines.push("");
          lines.push(
            filtered.count > 0
              ? filtered.text
              : "(none — try a shorter word, or snapshot without find to see the page)"
          );
        } else {
          lines.push(
            `Elements: ${result.visibleCount} visible, ${result.offscreenCount} offscreen (scroll to reach [offscreen] elements)`
          );
          lines.push("");
          lines.push(renderTree(result.tree).text);
        }
        const overlays = formatOverlays(result.overlays);
        if (overlays.length > 0) lines.push("", overlays);
        lines.push("");
        lines.push(
          'Use @eN refs in browser_interact (e.g. ref:"@e1"). Refs stay valid while the element is on the page.'
        );

        return this.ok(lines.join("\n"));
      }

      case "extract": {
        const selector =
          typeof args.selector === "string" ? args.selector.trim() : "";
        if (selector.length === 0)
          return this.err(
            'extract needs a selector for the rows, e.g. selector:"li" or selector:"table".'
          );
        const fields: Record<string, string> = {};
        if (args.fields != null && typeof args.fields === "object") {
          for (const [name, value] of Object.entries(
            args.fields as Record<string, unknown>
          )) {
            if (typeof value === "string" && value.trim().length > 0)
              fields[name] = value;
          }
        }
        const limit = numericArg(args.limit, 25, { min: 1, max: 100 });
        let result: { status?: string; total?: number; rows?: unknown[] };
        try {
          result = await this.evalJS(
            wc,
            extractScript(selector, fields, limit)
          );
        } catch (error) {
          return this.err(
            `Invalid selector "${selector}": ${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (result?.status !== "ok")
          return this.err(
            `Nothing matches "${selector}". Take a snapshot to see what the page has, then pick a selector from a real element.`
          );
        const rows = result.rows ?? [];
        const json = JSON.stringify(rows, null, 1);
        const body =
          json.length > 20_000
            ? `${json.slice(0, 20_000)}\n...(truncated)`
            : json;

        return this.ok(
          `${rows.length} of ${result.total ?? rows.length} rows matching "${selector}":\n${body}`
        );
      }

      case "screenshot": {
        // The description is all a text-only model gets.
        let summary = "";
        try {
          const raw = (await this.evalJS(wc, PAGE_SUMMARY_JS)) as PageSummary;
          summary = formatPageSummary(raw);
        } catch {
          summary = `Page: ${wc.getTitle()}\nURL: ${wc.getURL()}`;
        }

        const image = await this.captureImage(wc);
        if (image == null) {
          return this.ok(
            `${summary}\n\n(No screenshot could be captured; the description above is what the page shows.)`
          );
        }
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        pruneOldScreenshots();
        const filePath = path.join(
          TEMP_DIR,
          `screenshot-${Date.now()}.${image.mimeType === "image/png" ? "png" : "jpg"}`
        );
        fs.writeFileSync(filePath, Buffer.from(image.data, "base64"));

        return {
          content: [
            { type: "image", data: image.data, mimeType: image.mimeType },
            {
              type: "text",
              text: `${summary}\n\nScreenshot saved to ${filePath}`,
            },
          ],
        };
      }

      case "text": {
        const sel = (args.selector as string) ?? "body";
        const text = await this.evalJS(
          wc,
          `document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`
        );
        if (text == null) return this.err(`No element found: ${sel}`);
        return this.ok(
          typeof text === "string" && text.length > 20000
            ? text.slice(0, 20000) + "\n...(truncated)"
            : text
        );
      }

      case "url":
        return this.ok(wc.getURL());
      case "title":
        return this.ok(wc.getTitle());
      default:
        return this.err(
          `Unknown snapshot action: ${action || "(none)"}. Use snapshot (with find:"..." to filter), extract, text, screenshot, url or title.`
        );
    }
  }

  /** Actions after which the page is expected to have changed. */
  private static readonly REPORTS_CHANGES = new Set([
    "click",
    "fill",
    "type",
    "select",
    "press",
    "check",
    "uncheck",
  ]);

  private async executeInteract(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const action = (args.action as string) ?? "";
    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(NO_BROWSER);

    // A page-initiated navigation leaves the ref map on the old page.
    // Re-snapshot silently: refs are stable, and a missing one is reported by
    // the action itself.
    const snapshot = this.snapshots.for(sessionId);
    if (
      typeof args.ref === "string" &&
      snapshot.url != null &&
      wc.getURL() !== snapshot.url
    ) {
      const fresh = await this.takeSnapshot(wc, sessionId).catch(() => null);
      if (fresh?.tree == null) {
        snapshot.refMap.clear();
        snapshot.url = null;
        return this.err(
          `The page has navigated since the last snapshot (now at ${wc.getURL()}), so its refs are stale. ` +
            'Run browser_snapshot action:"snapshot" to get fresh refs.'
        );
      }
      if (!snapshot.refMap.has(args.ref)) {
        const compact = filterSnapshot(
          fresh.tree,
          { interactiveOnly: true },
          25
        );
        return this.err(
          `The page has navigated to ${fresh.url} and ${args.ref} is not on it. Elements there now:\n${compact.text}`
        );
      }
    }

    if (action === "pick") return await this.pick(wc, args, sessionId);
    if (action === "dismiss") return await this.dismiss(wc, sessionId);

    const before = McpBrowserServer.REPORTS_CHANGES.has(action)
      ? this.captureBefore(wc, sessionId)
      : null;
    let result = await this.interactStep(wc, args, sessionId);
    // The element was there at the snapshot and is not now: the page
    // re-rendered under a stable ref (refs key on the selector), so one fresh
    // snapshot usually brings it back. A model told only "take a snapshot"
    // spends two turns on what one retry does here.
    if (
      result.isError === true &&
      typeof args.ref === "string" &&
      McpBrowserServer.isVanished(result)
    ) {
      const fresh = await this.takeSnapshot(wc, sessionId).catch(() => null);
      if (fresh?.tree != null && snapshot.refMap.has(args.ref)) {
        const retried = await this.interactStep(wc, args, sessionId);
        if (retried.isError !== true) {
          const text = retried.content[0]?.text ?? "";
          result = this.ok(
            `(The page had re-rendered; refs were refreshed and the action retried.) ${text}`
          );
        }
      }
    }
    if (before == null || result.isError === true) return result;

    const changes = await this.reportChanges(wc, sessionId, before);
    const text = result.content[0]?.text ?? "";

    return this.ok(changes.length > 0 ? `${text}\n${changes}` : text);
  }

  private async interactStep(
    wc: BrowserPage,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const action = (args.action as string) ?? "";
    const snapshot = this.snapshots.for(sessionId);

    switch (action) {
      case "click": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        await this.animateCursorToElement(wc, sel).catch(() => {});
        const result = await this.evalJS(wc, clickScript(sel));
        if (result?.status === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result?.status === "disabled") {
          return this.err(
            `${this.label(args)} is disabled, so the click did nothing. ` +
              "Whatever the page needs before it enables the control has not happened yet."
          );
        }
        this.animateCursorClick();
        const detail = result?.text ? ` "${result.text.trim()}"` : "";
        return this.ok(
          `Clicked ${this.label(args)}${detail} at (${result?.x},${result?.y}).`
        );
      }

      case "fill": {
        const text = args.text as string;
        if (text == null) return this.err('"text" is required for fill.');
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        await this.animateCursorToElement(wc, sel).catch(() => {});
        this.animateCursorClick();
        // The native value setter is called on the element's own prototype;
        // HTMLInputElement's throws "Illegal invocation" on a contenteditable.
        const result = await this.evalJS(wc, fillScript(sel, text));
        if (result?.status === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result?.status === "not_fillable") {
          return this.err(
            `${this.label(args)} is a <${result.tag}>, which has no value to fill. ` +
              "Take a snapshot and pick an input, textarea, or contenteditable element."
          );
        }
        if (result?.status === "not_editable") {
          return this.err(
            `${this.label(args)} is disabled or read-only, so nothing was typed into it.`
          );
        }
        if (result?.status === "rejected") {
          return this.err(
            `Filled ${this.label(args)}, but the page reset its value — it is likely controlled by a framework ` +
              'that ignores programmatic input. Try interact action:"type", or press keys into it.'
          );
        }
        const preview = text.length > 30 ? text.slice(0, 27) + "..." : text;
        return this.ok(`Filled ${this.label(args)} with "${preview}".`);
      }

      case "type": {
        const text = args.text as string;
        if (text == null) return this.err('"text" is required for type.');
        // An expired ref is an error, not a reason to type into whatever is
        // focused.
        const resolved = this.target(args, sessionId);
        if (resolved.kind === "stale-ref")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.kind === "selector" ? resolved.selector : null;
        const target = sel
          ? `document.querySelector(${JSON.stringify(sel)})`
          : "document.activeElement";
        if (sel) {
          await this.animateCursorToElement(wc, sel).catch(() => {});
          this.animateCursorClick();
        }
        const result = await this.evalJS(wc, typeScript(target, text));
        if (result?.status === "not_found") {
          return this.err(
            sel
              ? this.notFoundError(args, sel)
              : "Nothing is focused on the page, so there is no element to type into. Pass a ref from a snapshot."
          );
        }
        if (result?.status === "not_fillable") {
          return this.err(
            `${this.label(args)} is a <${result.tag}>, which has no value to type into. ` +
              "Take a snapshot and pick an input, textarea, or contenteditable element."
          );
        }
        if (result?.status === "not_editable") {
          return this.err(
            `${this.label(args)} is disabled or read-only, so nothing was typed into it.`
          );
        }
        if (result?.status === "rejected") {
          return this.err(
            `Typed into ${this.label(args)}, but the page reset its value — it is likely controlled by a ` +
              "framework that ignores programmatic input."
          );
        }
        return this.ok(`Typed into ${this.label(args)}.`);
      }

      case "select": {
        const resolved = this.target(args, sessionId);
        const value = args.value as string;
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        if (value == null) return this.err('"value" is required for select.');
        await this.animateCursorToElement(wc, sel).catch(() => {});
        this.animateCursorClick();
        // Assigning an unmatched value to a <select> silently clears it, so the
        // element's own state decides and a miss lists what was there.
        const result = await this.evalJS(wc, selectScript(sel, value));
        if (result?.status === "not_found")
          return this.err(`No <select> found: ${this.label(args)}`);
        if (result?.status === "no_match") {
          const options = Array.isArray(result.options)
            ? result.options.join(", ")
            : "";
          return this.err(
            `No option "${value}" in ${this.label(args)}; nothing was selected.` +
              (options.length > 0 ? ` Available values: ${options}` : "")
          );
        }
        return this.ok(
          `Selected "${result?.selected ?? value}" in ${this.label(args)}.`
        );
      }

      case "hover": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        await this.animateCursorToElement(wc, sel).catch(() => {});
        const result = await this.evalJS(
          wc,
          `(function() {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return 'not_found';
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          return 'ok';
        })()`
        );
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        return this.ok(`Hovered over ${this.label(args)}.`);
      }

      case "scroll": {
        const direction = (args.direction as string) ?? "down";
        // Coerced, not cast: interpolated into the page source below.
        const amount = numericArg(args.amount, 500, {
          min: -100_000,
          max: 100_000,
        });
        const scrollTarget = this.target(args, sessionId);
        if (scrollTarget.kind === "stale-ref")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel =
          scrollTarget.kind === "selector" ? scrollTarget.selector : null;
        const dx =
          direction === "right" ? amount : direction === "left" ? -amount : 0;
        const dy =
          direction === "down" ? amount : direction === "up" ? -amount : 0;
        // Report the distance actually covered, so the tool can say there is
        // no more page left instead of an endless "scrolled 500px".
        const moved = await this.evalJS(
          wc,
          `(function(){
          const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "null"};
          const box = el || document.scrollingElement || document.documentElement;
          const beforeX = box.scrollLeft, beforeY = box.scrollTop;
          if (el) el.scrollBy(${dx}, ${dy}); else window.scrollBy(${dx}, ${dy});
          return { dx: box.scrollLeft - beforeX, dy: box.scrollTop - beforeY };
        })()`
        );
        const covered = Math.abs(moved?.dx ?? 0) + Math.abs(moved?.dy ?? 0);
        if (covered === 0) {
          return this.ok(
            `Scroll had no effect — ${sel ? this.label(args) : "the page"} is already at the ${direction} limit.`
          );
        }
        return this.ok(
          `Scrolled ${direction} ${covered}px. Take a new snapshot to see updated element positions.`
        );
      }

      case "scroll_into_view": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        const result = await this.evalJS(
          wc,
          `(function() {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return 'not_found';
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return 'ok';
        })()`
        );
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        await this.animateCursorToElement(wc, sel).catch(() => {});
        return this.ok(`Scrolled ${this.label(args)} into view.`);
      }

      case "focus": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        await this.animateCursorToElement(wc, sel).catch(() => {});
        // focus() on an unfocusable element is a no-op, and the next move is
        // usually to type into whatever was focused before.
        const result = await this.evalJS(
          wc,
          `(function() {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return 'not_found';
          el.focus();
          return document.activeElement === el ? 'ok' : 'not_focusable';
        })()`
        );
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result === "not_focusable") {
          return this.err(
            `${this.label(args)} did not take focus — it is not a focusable element. ` +
              "Give it a tabindex, or aim at the input inside it."
          );
        }
        return this.ok(`Focused ${this.label(args)}.`);
      }

      case "check":
      case "uncheck": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        const want = action === "check";
        await this.animateCursorToElement(wc, sel).catch(() => {});
        this.animateCursorClick();
        const result = await this.evalJS(wc, checkScript(sel, want));
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result === "unchanged") {
          return this.err(
            `Clicked ${this.label(args)}, but it is still ${want ? "unchecked" : "checked"}. ` +
              "The control may be disabled or handled by a custom widget — take a snapshot to check."
          );
        }
        return this.ok(
          `${want ? "Checked" : "Unchecked"} ${this.label(args)}.`
        );
      }

      case "press": {
        const key = (args.key as string) ?? (args.text as string);
        if (!key)
          return this.err(
            '"key" is required for press (e.g. "Enter", "Control+a").'
          );
        const { key: mainKey, modifiers: mods } = parseKeyCombo(key);

        // Through the debugger, so the key event is trusted and the default
        // action runs: a `new KeyboardEvent` reaches listeners, but Enter does
        // not submit and arrows do not move a listbox selection.
        try {
          await this.dispatchTrustedKey(wc, mainKey, mods);

          return this.ok(`Pressed ${key}.`);
        } catch {
          // Debugger unavailable: the synthetic path is worse, but not nothing.
        }

        await this.evalJS(
          wc,
          `(function() {
          const el = document.activeElement || document.body;
          const opts = {
            key: ${JSON.stringify(mainKey)},
            code: ${JSON.stringify(mainKey.length === 1 ? "Key" + mainKey.toUpperCase() : mainKey)},
            ctrlKey: ${mods.includes("control") || mods.includes("ctrl")},
            shiftKey: ${mods.includes("shift")},
            altKey: ${mods.includes("alt")},
            metaKey: ${mods.includes("meta") || mods.includes("command")},
            bubbles: true, cancelable: true,
          };
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keypress', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: opts.key, code: opts.code, bubbles: true }));
          if (${JSON.stringify(mainKey)} === 'Enter' && el.form) {
            el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
          }
        })()`
        );
        return this.ok(`Pressed ${key}.`);
      }

      case "wait": {
        const timeout = numericArg(args.amount, 5000, { min: 0, max: 120_000 });
        // A stale ref must not fall through to a sleep reported as success.
        const waitTarget = this.target(args, sessionId);
        if (waitTarget.kind === "stale-ref")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = waitTarget.kind === "selector" ? waitTarget.selector : null;
        const waitText = args.text as string | undefined;
        const urlPattern = args.url_pattern as string | undefined;

        if (sel) {
          const found = await this.evalJS(
            wc,
            `new Promise(r => {
            if (document.querySelector(${JSON.stringify(sel)})) { r(true); return; }
            const o = new MutationObserver(() => {
              if (document.querySelector(${JSON.stringify(sel)})) { o.disconnect(); r(true); }
            });
            o.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { o.disconnect(); r(false); }, ${timeout});
          })`
          );
          if (!found)
            return this.err(
              `Timed out waiting for element: ${this.label(args)}`
            );
          return this.ok(`Element appeared: ${this.label(args)}.`);
        }
        if (waitText) {
          const found = await this.evalJS(
            wc,
            `new Promise(r => {
            if (document.body.innerText.includes(${JSON.stringify(waitText)})) { r(true); return; }
            const o = new MutationObserver(() => {
              if (document.body.innerText.includes(${JSON.stringify(waitText)})) { o.disconnect(); r(true); }
            });
            o.observe(document.body, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { o.disconnect(); r(false); }, ${timeout});
          })`
          );
          if (!found)
            return this.err(`Timed out waiting for text: "${waitText}"`);
          return this.ok(`Text appeared: "${waitText}".`);
        }
        if (urlPattern) {
          const regexSource = globToRegexSource(urlPattern);
          const found = await this.evalJS(
            wc,
            `new Promise(r => {
            const re = new RegExp(${JSON.stringify(regexSource)});
            if (re.test(location.href)) { r(true); return; }
            const id = setInterval(() => { if (re.test(location.href)) { clearInterval(id); r(true); } }, 100);
            setTimeout(() => { clearInterval(id); r(false); }, ${timeout});
          })`
          );
          if (!found)
            return this.err(`Timed out waiting for URL: ${urlPattern}`);
          return this.ok(`URL matched: ${urlPattern}.`);
        }
        await new Promise((r) => setTimeout(r, Math.min(timeout, 10000)));
        return this.ok(`Waited ${timeout}ms.`);
      }

      default:
        return this.err(
          `Unknown interact action: ${action || "(none)"}. Use click, fill, pick, type, select, press, dismiss, check, uncheck, hover, focus, scroll, scroll_into_view or wait.`
        );
    }
  }

  private async executeExecute(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(NO_BROWSER);
    const code = args.code as string;
    if (!code) return this.err('"code" is required.');

    // Models write `document.title` far more often than `return document.title`,
    // so an expression is tried as one first; only non-expressions fall
    // through to a statement body.
    const attempts = planExecuteAttempts(code);
    let lastError: unknown = null;

    for (const [index, body] of attempts.entries()) {
      try {
        const result = await this.evalJS(
          wc,
          `(async function() { ${body} })()`
        );
        const str =
          result !== undefined ? JSON.stringify(result, null, 2) : "undefined";

        return this.ok(
          str.length > 20000 ? str.slice(0, 20000) + "\n...(truncated)" : str
        );
      } catch (e) {
        lastError = e;

        // Only a parse failure means the wrapping guess was wrong; retrying on
        // anything else runs `el.click()` twice.
        if (index === attempts.length - 1 || !isSyntaxError(e)) break;
      }
    }

    return this.err(
      `JS Error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  /** An element the snapshot had and the page no longer has. */
  private static isVanished(result: ToolResult): boolean {
    const text = result.content[0]?.text ?? "";

    return text.includes("not found on the page");
  }

  private label(args: Record<string, unknown>): string {
    return (args.ref as string) ?? (args.selector as string) ?? "(no target)";
  }

  private refError(args: Record<string, unknown>, loaded: number): string {
    if (args.ref) {
      return (
        `Ref ${args.ref} not found in current ref map (${loaded} refs loaded). ` +
        'Refs expire after any page change or navigation. Run browser_snapshot action:"snapshot" to get fresh refs.'
      );
    }
    return 'A ref is required. Run browser_snapshot action:"snapshot" first, then use an @eN ref from the output.';
  }

  private notFoundError(args: Record<string, unknown>, sel: string): string {
    const ref = args.ref as string | undefined;
    if (ref) {
      return (
        `Element for ${ref} not found on the page (selector: ${sel}). ` +
        'The page may have changed since the last snapshot. Run browser_snapshot action:"snapshot" to get fresh refs.'
      );
    }
    return `Element not found: ${sel}. The page DOM may have changed. Take a new snapshot and use @eN refs instead of CSS selectors.`;
  }
}
