import http from "http";
import type net from "net";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * What a tool returns: the SDK's own result type, so a block the SDK would
 * reject at run time (an unknown type, non-base64 image data) fails to compile
 * instead of reaching the model as a -32602 validation dump.
 */
export type McpToolResult = CallToolResult;

import { localMcpServerToken } from "./mcp-config-service";

/**
 * The HTTP side every built-in MCP server shares: a loopback listener behind
 * the per-boot bearer token, speaking MCP's Streamable HTTP transport through
 * the SDK, which owns the protocol (version negotiation, ping, notifications
 * that get no reply). A subclass supplies only its tool list and
 * `executeTool`.
 *
 * Stateless: each request gets its own SDK server and transport, built around
 * the `session` query parameter the runtime MCP config puts in the URL, which
 * names the calling conversation. A GET opens the standalone SSE stream a
 * client may hold for server notifications; that pair lives until the stream
 * closes so `notifyToolListChanged` can reach it. With no session there is
 * nothing for a DELETE to end, so it gets 405 (as the spec allows) and a
 * client closes its own GET stream.
 *
 * DNS rebinding: only the loopback authorities this server is reached at are
 * accepted as Host, and a request carrying any other page's Origin is refused,
 * checked before the token so a rebound page learns nothing.
 */

/** One entry of `tools/list`, passed through as written. */
export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface McpServerInfo {
  /** Also the key of the bearer token the runtime MCP config carries. */
  name: string;
  version: string;
  /** Whether `notifyToolListChanged` is ever called; advertised as such. */
  listChanged?: boolean;
}

interface Connection {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

type Sdk = typeof import("./mcp-sdk");

/** How long stop() lets an in-flight response finish. */
const STOP_GRACE_MS = 1_000;

/** One load for every server, shared by concurrent first starts. */
let sdkPromise: Promise<Sdk> | null = null;

export abstract class McpHttpServer {
  private listener: http.Server | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  /** Bumped by stop(), so a start() it overtook knows to give up. */
  private generation = 0;
  /** Set before the listener exists, so every request can use it. */
  private sdk: Sdk | null = null;
  /** Open notification streams (GET), each with the SDK server behind it. */
  private readonly streams = new Set<Connection>();

  protected constructor(private readonly info: McpServerInfo) {}

  /** The tools `tools/list` advertises to this caller. */
  protected abstract listTools(callerSession?: string): McpToolListing[];

  protected abstract executeTool(
    name: string,
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<McpToolResult>;

  /**
   * Listens on port 0 and reads the port back, so no other process can take
   * it between a probe and the real listen. A stop() before the listener is
   * up wins: that start() rejects and closes what it opened.
   */
  start(): Promise<number> {
    if (this.listener != null) return Promise.resolve(this.port!);
    if (this.starting != null) return this.starting;
    const starting = this.listen(this.generation).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async listen(generation: number): Promise<number> {
    const superseded = (): Error =>
      new Error(`${this.info.name} MCP server stopped while starting`);
    // Loaded here rather than imported at the top: see mcp-sdk.ts.
    sdkPromise ??= import("./mcp-sdk").catch((error: unknown) => {
      // A failed load is retried on the next start, not cached.
      sdkPromise = null;
      throw error;
    });
    const sdk = await sdkPromise;
    if (generation !== this.generation) throw superseded();
    this.sdk = sdk;
    return new Promise<number>((resolve, reject) => {
      const listener = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      listener.once("error", reject);
      // Loopback only: these servers are for the agent on this machine.
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        if (generation !== this.generation) {
          listener.close();
          reject(superseded());
          return;
        }
        this.listener = listener;
        this.port = (listener.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  /**
   * Stops accepting at once and drops idle connections. A response already
   * being produced, such as a tool call whose permission prompt was just
   * denied, gets STOP_GRACE_MS to be written before its socket is cut.
   */
  stop(): void {
    this.generation += 1;
    this.starting = null;
    for (const connection of this.streams) void this.close(connection);
    this.streams.clear();
    if (this.listener != null) {
      const listener = this.listener;
      listener.close();
      listener.closeIdleConnections();
      setTimeout(() => listener.closeAllConnections(), STOP_GRACE_MS).unref();
      this.listener = null;
      this.port = null;
    }
  }

  getPort(): number | null {
    return this.port;
  }

  isRunning(): boolean {
    return this.listener != null;
  }

  /**
   * Push `notifications/tools/list_changed` to every open stream so a client
   * re-runs `tools/list`. Only meaningful with `listChanged: true`, which a
   * client checks before it listens.
   */
  notifyToolListChanged(): void {
    for (const { server } of this.streams) {
      server.sendToolListChanged().catch(() => {
        /* closed; its close handler drops it from the set */
      });
    }
  }

  private async close({ server, transport }: Connection): Promise<void> {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  /** The SDK server for one request, bound to the conversation asking. */
  private serverFor(sdk: Sdk, callerSession?: string): Server {
    const server = new sdk.Server(
      { name: this.info.name, version: this.info.version },
      {
        capabilities: {
          tools: { listChanged: this.info.listChanged === true },
        },
        jsonSchemaValidator: sdk.validator,
      }
    );
    // The definitions are JSON Schema already and go out exactly as written.
    server.setRequestHandler(
      sdk.ListToolsRequestSchema,
      () => ({ tools: this.listTools(callerSession) }) as ListToolsResult
    );
    server.setRequestHandler(sdk.CallToolRequestSchema, (request) =>
      this.executeTool(
        request.params.name,
        request.params.arguments ?? {},
        callerSession
      )
    );
    return server;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // No CORS headers on purpose: a wildcard origin would let any page the
    // user browsed call tools/call on loopback.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      this.json(res, 200, {
        status: "ok",
        server: this.info.name,
        version: this.info.version,
      });
      return;
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      res.writeHead(404);
      res.end();
      return;
    }

    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    const allowedOrigins = allowedHosts.map((host) => `http://${host}`);
    const origin = req.headers.origin;
    if (
      !allowedHosts.includes(req.headers.host ?? "") ||
      (origin != null && !allowedOrigins.includes(origin))
    ) {
      this.json(res, 403, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Forbidden host or origin" },
      });
      return;
    }

    // Per-boot bearer token from the runtime MCP config; a browser gets 401.
    if (
      req.headers.authorization !==
      `Bearer ${localMcpServerToken(this.info.name)}`
    ) {
      this.json(res, 401, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Unauthorized" },
      });
      return;
    }

    // Stateless: no session for a DELETE to end (see above).
    if (req.method === "DELETE") {
      res.writeHead(405, { Allow: "GET, POST" });
      res.end();
      return;
    }

    const sdk = this.sdk!;
    const connection: Connection = {
      server: this.serverFor(sdk, url.searchParams.get("session") ?? undefined),
      // No session id: stateless, so a request needs no prior initialize
      // and nothing is left behind when a client goes away without a DELETE.
      transport: new sdk.StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        // The same allowlists as above, so the transport enforces them too.
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
      }),
    };
    const isStream = req.method === "GET";
    if (isStream) this.streams.add(connection);
    res.on("close", () => {
      if (isStream) this.streams.delete(connection);
      void this.close(connection);
    });

    try {
      await connection.server.connect(connection.transport);
      await connection.transport.handleRequest(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      this.json(res, 500, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
