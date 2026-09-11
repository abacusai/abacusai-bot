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

export class FakeMcpServer {
  /** Every tool call the agent made, in order. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private tools: FakeMcpTool[];

  private constructor(
    private readonly server: http.Server,
    readonly port: number,
    tools: FakeMcpTool[]
  ) {
    this.tools = tools;
  }

  static async start(tools: FakeMcpTool[] = []): Promise<FakeMcpServer> {
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
      tools
    );

    return instance;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** Change what the next `tools/list` reports — a server gaining a tool. */
  setTools(tools: FakeMcpTool[]): void {
    this.tools = tools;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(response: http.ServerResponse, body: string): void {
    const message = JSON.parse(body || "{}") as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    // A notification carries no id and expects no answer.
    if (message.id == null) {
      response.writeHead(202);
      response.end();

      return;
    }

    const send = (result: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
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
