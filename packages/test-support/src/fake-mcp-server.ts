/**
 * An MCP server on 127.0.0.1, so a test can exercise the real connect path in
 * `mcp/client.ts`: enough of the protocol for `initialize`, `tools/list` and
 * `tools/call`, with the tool list swappable between connections.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** What `tools/call` answers with. Defaults to the tool's own name. */
  reply?: (args: Record<string, unknown>) => string;
}

export interface FakeMcpServerOptions {
  /** Hold every answer this long: a slow server. */
  delayMs?: number;
  /**
   * Answer as an SSE stream. `"close"` ends the stream after the message;
   * `"hold"` keeps it open (as some hosted servers do) until the client
   * hangs up or the server closes.
   */
  sse?: "close" | "hold";
}

export class FakeMcpServer {
  /** Every tool call the agent made, in order. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Every JSON-RPC method the agent sent, in order. */
  readonly requests: string[] = [];
  /** How many connections went through `initialize`. */
  initializations = 0;
  private tools: FakeMcpTool[];
  private readonly held = new Set<http.ServerResponse>();

  private constructor(
    private readonly server: http.Server,
    readonly port: number,
    tools: FakeMcpTool[],
    private readonly options: FakeMcpServerOptions
  ) {
    this.tools = tools;
  }

  static async start(
    tools: FakeMcpTool[] = [],
    options: FakeMcpServerOptions = {}
  ): Promise<FakeMcpServer> {
    const server = http.createServer((request, response) => {
      let body = "";

      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => instance.handle(response, body));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );

    const instance = new FakeMcpServer(
      server,
      (server.address() as AddressInfo).port,
      tools,
      options
    );

    return instance;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** Change what the next `tools/list` reports: a server gaining a tool. */
  setTools(tools: FakeMcpTool[]): void {
    this.tools = tools;
  }

  async close(): Promise<void> {
    for (const response of this.held) response.end();
    this.held.clear();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(response: http.ServerResponse, body: string): void {
    const message = JSON.parse(body || "{}") as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    if (message.method != null) this.requests.push(message.method);
    if (message.method === "initialize") this.initializations += 1;

    // A notification carries no id and expects no answer.
    if (message.id == null) {
      response.writeHead(202);
      response.end();

      return;
    }

    const answer = (result: unknown): void => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });

      if (this.options.sse == null) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(payload);

        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(`event: message\ndata: ${payload}\n\n`);

      if (this.options.sse === "close") {
        response.end();
      } else {
        // Held open on purpose; a keep-alive comment shows the client the
        // stream is live, not stalled.
        this.held.add(response);
        response.on("close", () => this.held.delete(response));
        response.write(": keep-alive\n\n");
      }
    };

    const send = (result: unknown): void => {
      const delay = this.options.delayMs ?? 0;

      if (delay > 0) setTimeout(() => answer(result), delay);
      else answer(result);
    };

    switch (message.method) {
      case "initialize":
        send({
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "fake", version: "1" },
        });

        return;

      case "tools/list":
        send({
          tools: this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? `${tool.name} (fake)`,
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          })),
        });

        return;

      case "tools/call": {
        const name = message.params?.name ?? "";
        const args = message.params?.arguments ?? {};

        this.calls.push({ name, args });

        const tool = this.tools.find((candidate) => candidate.name === name);

        send({
          content: [
            { type: "text", text: tool?.reply?.(args) ?? `${name} ran` },
          ],
          isError: false,
        });

        return;
      }

      default:
        send({});
    }
  }
}

/** The `mcpServers` config file the agent reads, as JSON. */
export function mcpConfig(
  servers: Record<string, { url: string; isBuiltin?: boolean }>
): string {
  return JSON.stringify({ mcpServers: servers }, null, 2);
}
