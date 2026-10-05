import http from "http";
import type net from "net";

import { localMcpServerToken } from "./mcp-config-service";

/**
 * The HTTP side every built-in MCP server shares: a loopback listener behind
 * the per-boot bearer token, JSON-RPC over POST, and an SSE stream for clients
 * that open one. A subclass supplies only its tool list and `executeTool`.
 */

/** One entry of `tools/list`, passed through as written. */
export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

interface McpServerInfo {
  /** Also the key of the bearer token the runtime MCP config carries. */
  name: string;
  version: string;
  /** Whether `notifyToolListChanged` is ever called; advertised as such. */
  listChanged?: boolean;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = "2024-11-05";

/** How long stop() lets an in-flight response finish. */
const STOP_GRACE_MS = 1_000;

export abstract class McpHttpServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  /** Bumped by stop(), so a start() it overtook knows to give up. */
  private generation = 0;
  /** Open SSE streams, by the id handed out in their `endpoint` event. */
  private readonly streams = new Map<string, http.ServerResponse>();
  private streamCounter = 0;

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
    if (this.server != null) return Promise.resolve(this.port!);
    if (this.starting != null) return this.starting;
    const generation = this.generation;
    const starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) =>
        this.handleRequest(req, res)
      );
      server.once("error", reject);
      // Loopback only: these servers are for the agent on this machine.
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        if (generation !== this.generation) {
          server.close();
          reject(
            new Error(`${this.info.name} MCP server stopped while starting`)
          );
          return;
        }
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    }).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /**
   * Stops accepting at once and drops idle connections. A response already
   * being produced, such as a tool call whose permission prompt was just
   * denied, gets STOP_GRACE_MS to be written before its socket is cut.
   */
  stop(): void {
    this.generation += 1;
    this.starting = null;
    for (const res of this.streams.values()) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    this.streams.clear();
    if (this.server != null) {
      const server = this.server;
      server.close();
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), STOP_GRACE_MS).unref();
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

  /**
   * Push `notifications/tools/list_changed` to every open stream so a client
   * re-runs `tools/list`. Only meaningful with `listChanged: true`, which a
   * client checks before it listens.
   */
  notifyToolListChanged(): void {
    this.broadcast({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
  }

  private broadcast(message: JsonRpcMessage): void {
    const frame = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const res of this.streams.values()) {
      try {
        res.write(frame);
      } catch {
        /* closed; its close handler drops it from the map */
      }
    }
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    // No CORS headers on purpose: a wildcard origin would let any page the
    // user browsed call tools/call on loopback.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
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
      if (req.method === "GET") this.openStream(res);
      else if (req.method === "POST") this.handlePost(req, res, url);
      else if (req.method === "DELETE") this.closeStream(url, res);
      else {
        res.writeHead(405);
        res.end();
      }
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

    res.writeHead(404);
    res.end();
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private openStream(res: http.ServerResponse): void {
    const streamId = `session-${++this.streamCounter}`;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: endpoint\ndata: /mcp?sessionId=${streamId}\n\n`);
    this.streams.set(streamId, res);
    res.on("close", () => this.streams.delete(streamId));
  }

  private closeStream(url: URL, res: http.ServerResponse): void {
    const streamId = url.searchParams.get("sessionId");
    const stream = streamId != null ? this.streams.get(streamId) : undefined;
    if (stream != null) {
      try {
        stream.end();
      } catch {
        /* already closed */
      }
      this.streams.delete(streamId!);
    }
    res.writeHead(200);
    res.end();
  }

  private handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): void {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      // Malformed JSON is a Parse error (-32700); a handler that threw is an
      // Internal error (-32603) carrying the request id and message.
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(body) as JsonRpcMessage;
      } catch {
        this.json(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }

      // A notification (or a client's response) carries no id and gets no
      // reply: JSON-RPC forbids one, and MCP answers the POST with 202.
      if (message.id == null) {
        res.writeHead(202);
        res.end();
        return;
      }

      let response: JsonRpcResponse;
      try {
        // The runtime MCP config URL carries the UI session id, which is how
        // a tool knows which conversation is asking.
        const callerSession = url.searchParams.get("session") ?? undefined;
        response = await this.dispatch(message, callerSession);
      } catch (error) {
        this.json(res, 500, {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
        return;
      }

      // A client on the SSE transport gets its answer over its stream.
      const stream = this.streams.get(url.searchParams.get("sessionId") ?? "");
      if (stream != null) {
        try {
          stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        } catch {
          /* closed */
        }
        res.writeHead(202);
        res.end();
        return;
      }
      this.json(res, 200, response);
    });
  }

  private async dispatch(
    request: JsonRpcMessage,
    callerSession?: string
  ): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    const params = request.params ?? {};
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: this.info.listChanged === true },
            },
            serverInfo: { name: this.info.name, version: this.info.version },
          },
        };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: this.listTools(callerSession) },
        };
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        return {
          jsonrpc: "2.0",
          id,
          result: await this.executeTool(name, args, callerSession),
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        };
    }
  }
}
