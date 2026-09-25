/**
 * A tool set that changes mid-session has to tell the client so.
 *
 * The bug: a chat opened before WhatsApp connected kept its startup tool list
 * and reported "I don't have a WhatsApp tool" even after the link. The server
 * exposes tools dynamically (a platform's tools appear when it connects), so it
 * must advertise `listChanged: true` and push `notifications/tools/list_changed`
 * to every open connection when availability flips: the standard MCP signal to
 * re-run tools/list.
 */
import http from "http";

import { afterEach, describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";
import { localMcpServerToken } from "./mcp-config-service";

const AUTH = { Authorization: `Bearer ${localMcpServerToken("agent-tools")}` };

const build = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    botIdForSession: () => "bot-1",
    messaging: {
      runningPlatforms: () => [],
      livePlatforms: () => [],
      listChats: () => [],
      send: async () => {},
      readMessages: async () => [],
      autoReply: {
        status: () => ({
          enabled: false,
          botId: null,
          approved: [],
          pending: [],
        }),
        enable: () => {},
        disable: () => {},
        senderCandidates: () => [],
        allowSender: () => {},
        removeSender: () => {},
      },
    },
  } as never);

let server: McpAgentToolsServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

const post = (port: number, body: object): Promise<string> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: AUTH },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });

describe("dynamic tool availability", () => {
  it("advertises listChanged in the initialize handshake", async () => {
    server = build();
    const port = await server.start();

    const body = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const parsed = JSON.parse(body) as {
      result: { capabilities: { tools: { listChanged: boolean } } };
    };
    expect(parsed.result.capabilities.tools.listChanged).toBe(true);
  });

  it("pushes tools/list_changed to an open connection when availability flips", async () => {
    server = build();
    const port = await server.start();

    // Open the SSE channel the way the agent's MCP client does.
    const frames: string[] = [];
    const sse = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/mcp", method: "GET", headers: AUTH },
        resolve
      );
      req.on("error", reject);
      req.end();
    });
    sse.on("data", (c: Buffer) => frames.push(c.toString()));

    // Let the endpoint handshake frame arrive, then flip availability.
    await new Promise((r) => setTimeout(r, 20));
    server.notifyToolListChanged();
    await new Promise((r) => setTimeout(r, 20));

    const stream = frames.join("");
    expect(stream).toContain("notifications/tools/list_changed");

    // It is a JSON-RPC notification: a method, and no id to answer.
    const dataLine = stream
      .split("\n")
      .find(
        (line) => line.startsWith("data:") && line.includes("list_changed")
      );
    expect(dataLine).toBeDefined();
    const message = JSON.parse(dataLine!.replace(/^data:\s*/, "")) as {
      method: string;
      id?: unknown;
    };
    expect(message.method).toBe("notifications/tools/list_changed");
    expect(message.id).toBeUndefined();

    sse.destroy();
  });

  it("does not throw when there is no open connection to notify", () => {
    server = build();
    expect(() => server!.notifyToolListChanged()).not.toThrow();
  });
});
