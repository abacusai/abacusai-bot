/**
 * MCP, end to end: a real server on loopback, the real client, a real session.
 *
 * `mcp/client.ts` is the entire MCP implementation and was covered only by a
 * naming unit test, so nothing exercised the handshake, discovery, a tool call,
 * or what a refresh does. The refresh is the interesting one: it is what the
 * desktop's "reconnect" button runs, and the commonest reason to press it is a
 * server that was not there a moment ago.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeMcpServer,
  mcpConfig,
} from "@abacus-ai/test-support/fake-mcp-server";
import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DesktopEvent } from "../protocol.js";
import { AbacusBotSession } from "../session.js";

let provider: FakeProvider;
let home: string;
let configPath: string;

/** A session pointed at the fake model, with everything it emitted. */
class Harness {
  readonly events: DesktopEvent[] = [];
  readonly session: AbacusBotSession;
  readonly cwd: string;

  constructor() {
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-mcp-"));
    this.session = new AbacusBotSession({
      cwd: this.cwd,
      mode: "yolo",
      emit: (event) => this.events.push(event),
    });
  }

  get servers(): Array<{ name: string; status: string; toolCount: number }> {
    const last = [...this.events]
      .reverse()
      .find(
        (event): event is Extract<DesktopEvent, { type: "mcp_servers" }> =>
          event.type === "mcp_servers"
      );

    return last?.servers ?? [];
  }

  dispose(): void {
    this.session.dispose();
    fs.rmSync(this.cwd, { recursive: true, force: true });
  }
}

let harnesses: Harness[] = [];
let servers: FakeMcpServer[] = [];

function session(): Harness {
  const harness = new Harness();

  harnesses.push(harness);

  return harness;
}

async function mcpServer(
  tools: Parameters<typeof FakeMcpServer.start>[0],
  options?: Parameters<typeof FakeMcpServer.start>[1]
): Promise<FakeMcpServer> {
  const server = await FakeMcpServer.start(tools, options);

  servers.push(server);

  return server;
}

/** The tool names the model was offered on the most recent request. */
function offeredTools(): string[] {
  return provider.calls.at(-1)?.tools ?? [];
}

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-mcp-home-"));
  configPath = path.join(home, "mcp.json");
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_MCP_CONFIG = configPath;
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_MCP_CONFIG;
});

afterEach(async () => {
  for (const harness of harnesses) harness.dispose();
  harnesses = [];
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
});

describe("connecting", () => {
  it("handshakes, discovers the tools, and reports the server", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    expect(harness.servers).toEqual([
      expect.objectContaining({
        name: "docs",
        status: "connected",
        toolCount: 1,
      }),
    ]);
  });

  it("offers the tool to the model under its server-qualified name", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    // A user server's `lookup` becomes `docs_lookup`, so two servers offering
    // the same name stay distinct.
    expect(offeredTools()).toContain("docs_lookup");
  });

  it("does not take the gateway's GitHub tools: gh on the user's own token is the path", async () => {
    const server = await mcpServer([
      { name: "Gmail_Tool" },
      { name: "Git_Tool" },
      { name: "Github_Tool" },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ "abacus-connectors": { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    const offered = offeredTools();
    expect(offered).toContain("abacus-connectors_Gmail_Tool");
    expect(offered).not.toContain("abacus-connectors_Git_Tool");
    expect(offered).not.toContain("abacus-connectors_Github_Tool");
  });

  it("tells the model it is connected, so it does not have to guess", async () => {
    const server = await mcpServer([{ name: "goto" }, { name: "click" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ playwright: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("are you connected to playwright?");

    // Having the tools was never enough: asked by name, the model said no.
    const system = provider.calls
      .at(-1)
      ?.messages.filter((message) => message.role === "system")
      .map((message) => JSON.stringify(message.content))
      .join("\n");

    expect(system).toContain("playwright");
    expect(system).toContain("2 tools");
  });

  it("leaves a built-in server's names alone", async () => {
    const server = await mcpServer([{ name: "present_deliverable" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ "agent-tools": { url: server.url, isBuiltin: true } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    // Every component's hand-off text says `present_deliverable`; prefixing it
    // made the name in all of them wrong.
    expect(offeredTools()).toContain("present_deliverable");
  });

  it("calls the tool and hands the result back", async () => {
    const server = await mcpServer([
      { name: "lookup", reply: (args) => `looked up ${String(args.q)}` },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    provider.script((call, index) =>
      index === 0 && call.tools.includes("docs_lookup")
        ? { call: { name: "docs_lookup", args: { q: "widgets" } } }
        : { say: "done" }
    );

    await harness.session.start();
    await harness.session.send("look something up");

    expect(server.calls).toEqual([{ name: "lookup", args: { q: "widgets" } }]);
  });

  it("reports an unreachable server without taking the session down", async () => {
    // One unreachable server must never stop the agent starting: otherwise
    // the whole session dies because a simulator was not running.
    fs.writeFileSync(
      configPath,
      mcpConfig({ dead: { url: "http://127.0.0.1:1/mcp" } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    // Ready does not wait out the retries; the verdict lands after them.
    expect(harness.events.some((event) => event.type === "ready")).toBe(true);
    await harness.session.awaitMcpSettled();
    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "dead", status: "error" }),
    ]);
  });

  it("skips a server the user disabled", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { docs: { url: server.url, disabled: true } },
      }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "docs", status: "disconnected" }),
    ]);
    expect(offeredTools()).not.toContain("docs_lookup");
  });
});

describe("refreshing", () => {
  it("picks up a server that was not there when the session started", async () => {
    // The commonest reason to press reconnect: the server was down, or was
    // added a moment ago. The roster updated and the model's tool list did
    // not, so the panel said "connected, 1 tool" about a tool nothing could
    // call.
    fs.writeFileSync(configPath, mcpConfig({}), "utf8");

    const harness = session();

    await harness.session.start();

    const added = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: added.url } }),
      "utf8"
    );
    await harness.session.refreshMcp();
    await harness.session.send("hello");

    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "docs", toolCount: 1 }),
    ]);
    expect(offeredTools()).toContain("docs_lookup");
  });

  it("picks up a tool a connected server gained", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    server.setTools([{ name: "lookup" }, { name: "search" }]);
    await harness.session.refreshMcp();
    await harness.session.send("hello");

    expect(offeredTools()).toContain("docs_search");
  });

  it("continues the turn with a tool that landed while the turn ran", async () => {
    // The refresh that follows connect_connector lands inside the turn,
    // after the tool result. pi's tool list is fixed for the turn, so the
    // follow-up request cannot see the new tool; the turn is continued
    // once it ends, naming the arrival, and that request can.
    let harness: Harness | null = null;
    let refreshed: Promise<void> = Promise.resolve();
    const server = await mcpServer([
      {
        name: "connect",
        reply: () => {
          server.setTools([
            { name: "connect", reply: () => "connected" },
            { name: "Slack_Tool", reply: () => "sent" },
          ]);
          refreshed = new Promise((resolve) => {
            setTimeout(
              () => void harness!.session.refreshMcp().then(resolve),
              0
            );
          });
          return "Slack is connected.";
        },
      },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    harness = session();
    await harness.session.start();
    provider.script(async (_call, index) => {
      if (index === 0) return { call: { name: "docs_connect", args: {} } };
      if (index === 1) {
        await refreshed;
        return { say: "I cannot send that." };
      }
      return { say: "sent" };
    });
    await harness.session.send("connect slack and dm sreemanti hi");

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.tools).not.toContain("docs_Slack_Tool");
    expect(provider.calls[2]?.tools).toContain("docs_Slack_Tool");
    expect(provider.calls[2]?.userText.join("\n")).toMatch(
      /became available: docs_Slack_Tool/
    );
  });

  it("keeps routing the tools it already had", async () => {
    const server = await mcpServer([
      { name: "lookup", reply: () => "still here" },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.refreshMcp();

    provider.script((call, index) =>
      index === 0 && call.tools.includes("docs_lookup")
        ? { call: { name: "docs_lookup", args: {} } }
        : { say: "done" }
    );

    await harness.session.send("look something up");

    // The refresh closes the old clients, so a tool holding the old route
    // would be calling a closed connection.
    expect(server.calls).toHaveLength(1);
  });

  it("says so rather than failing when a server has gone away", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    fs.writeFileSync(configPath, mcpConfig({}), "utf8");
    await harness.session.refreshMcp();

    provider.script((call, index) =>
      index === 0 && call.tools.includes("docs_lookup")
        ? { call: { name: "docs_lookup", args: {} } }
        : { say: "done" }
    );

    await harness.session.send("look something up");

    const results = harness.events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "tool_execution_complete");

    expect(JSON.stringify(results)).toContain("No MCP server is connected");
  });
});

describe("a server that answers slowly", () => {
  // Every chat and bot used to be ready only when the slowest server had
  // answered: one remote server taking twenty seconds made every new chat
  // take twenty seconds, and every connector card wait as long.
  it("does not hold the session's start; its tools join when it lands", async () => {
    const slow = await mcpServer([{ name: "lookup" }], { delayMs: 1_500 });
    const quick = await mcpServer([{ name: "ping" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ slow: { url: slow.url }, quick: { url: quick.url } }),
      "utf8"
    );
    process.env.ABACUSAI_BOT_MCP_SETTLE_MS = "400";

    const harness = session();
    const startedAt = Date.now();

    try {
      await harness.session.start();

      expect(Date.now() - startedAt).toBeLessThan(1_400);
      expect(harness.servers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "quick", status: "connected" }),
          expect.objectContaining({ name: "slow", status: "connecting" }),
        ])
      );

      await harness.session.awaitMcpSettled();
      await harness.session.send("hello");

      expect(harness.servers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "slow",
            status: "connected",
            toolCount: 1,
            connectMs: expect.any(Number),
          }),
        ])
      );
      expect(offeredTools()).toContain("slow_lookup");
    } finally {
      delete process.env.ABACUSAI_BOT_MCP_SETTLE_MS;
    }
  });

  it("does not hold a refresh either", async () => {
    const quick = await mcpServer([{ name: "ping" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ quick: { url: quick.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    const slow = await mcpServer([{ name: "lookup" }], { delayMs: 1_500 });

    fs.writeFileSync(
      configPath,
      mcpConfig({ quick: { url: quick.url }, slow: { url: slow.url } }),
      "utf8"
    );
    process.env.ABACUSAI_BOT_MCP_SETTLE_MS = "400";
    const startedAt = Date.now();

    try {
      await harness.session.refreshMcp();

      expect(Date.now() - startedAt).toBeLessThan(1_400);
      await harness.session.awaitMcpSettled();
      await harness.session.send("hello");

      expect(offeredTools()).toContain("slow_lookup");
    } finally {
      delete process.env.ABACUSAI_BOT_MCP_SETTLE_MS;
    }
  });
});

describe("a server that keeps its event stream open", () => {
  // Some hosted servers answer over SSE and leave the stream open after the
  // message. Reading it to the end meant every connect and every tool call
  // lasted until the server hung up.
  it("is connected and called as soon as its answer arrives", async () => {
    const server = await mcpServer([{ name: "lookup", reply: () => "found" }], {
      sse: "hold",
    });

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();
    const startedAt = Date.now();

    await harness.session.start();

    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(harness.servers).toEqual([
      expect.objectContaining({
        name: "docs",
        status: "connected",
        toolCount: 1,
      }),
    ]);

    provider.script((call, index) =>
      index === 0 && call.tools.includes("docs_lookup")
        ? { call: { name: "docs_lookup", args: {} } }
        : { say: "done" }
    );

    await harness.session.send("look it up");

    expect(server.calls).toEqual([{ name: "lookup", args: {} }]);
  });
});

describe("a refresh that changes nothing about a server", () => {
  it("keeps its connection and re-reads its tool list", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    server.setTools([{ name: "lookup" }, { name: "search" }]);
    await harness.session.refreshMcp();
    await harness.session.send("hello");

    // One handshake, two listings: the gateway grows a tool per attached
    // account and a refresh has to see it without a reconnect.
    expect(server.initializations).toBe(1);
    expect(server.requests.filter((m) => m === "tools/list")).toHaveLength(2);
    expect(offeredTools()).toContain("docs_search");
    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "docs", toolCount: 2 }),
    ]);
  });

  it("reconnects it when asked to by name", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.refreshMcp({ force: ["docs"] });

    expect(server.initializations).toBe(2);
  });

  it("reconnects it when its entry changed", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { docs: { url: server.url, headers: { "X-Tenant": "b" } } },
      }),
      "utf8"
    );
    await harness.session.refreshMcp();

    expect(server.initializations).toBe(2);
  });
});

describe("a server with many tools", () => {
  const many = Array.from({ length: 26 }, (_, index) => ({
    name: `tool_${index}`,
    description:
      index === 3 ? "Creates a page in the workspace" : `Tool ${index}`,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
    },
    reply: (args: Record<string, unknown>) =>
      `ran ${index} with ${JSON.stringify(args)}`,
  }));

  it("is offered as a lookup and a call, not as every schema", async () => {
    const server = await mcpServer(many);

    fs.writeFileSync(
      configPath,
      mcpConfig({ notes: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    expect(offeredTools()).toContain("notes_tools");
    expect(offeredTools()).toContain("notes_call");
    expect(offeredTools()).not.toContain("notes_tool_3");
    // The roster still counts what the server has, not what is advertised.
    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "notes", toolCount: 26 }),
    ]);
  });

  it("describes a tool on request and runs it by name", async () => {
    const server = await mcpServer(many);

    fs.writeFileSync(
      configPath,
      mcpConfig({ notes: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    provider.script((call, index) => {
      if (index === 0)
        return { call: { name: "notes_tools", args: { query: "page" } } };
      if (index === 1)
        return {
          call: {
            name: "notes_call",
            args: { tool: "tool_3", arguments: { title: "Plan" } },
          },
        };
      return { say: "done" };
    });

    await harness.session.send("make a page");

    const results = harness.events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "tool_execution_complete");
    const text = JSON.stringify(results);

    expect(text).toContain("tool_3");
    expect(text).toContain("Creates a page");
    expect(text).toContain('"title"');
    expect(server.calls).toEqual([{ name: "tool_3", args: { title: "Plan" } }]);
  });

  it("leaves a small server's tools as they are", async () => {
    const server = await mcpServer(many.slice(0, 24));

    fs.writeFileSync(
      configPath,
      mcpConfig({ notes: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    expect(offeredTools()).toContain("notes_tool_3");
    expect(offeredTools()).not.toContain("notes_tools");
  });
});

describe("the browser sub-agent", () => {
  it("is given the browser tools rather than the parent loop", async () => {
    const server = await mcpServer([
      { name: "browser_navigate" },
      { name: "lookup" },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ browser: { url: server.url, isBuiltin: true } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    // A page walk is dozens of element trees the main transcript would carry
    // forever, so the parent gets `browser_task` and nothing else.
    expect(offeredTools()).toContain("browser_task");
    expect(offeredTools()).not.toContain("browser_navigate");
  });

  it("sees a browser server that only arrived on a refresh", async () => {
    const other = await mcpServer([{ name: "browser_navigate" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ browser: { url: other.url, isBuiltin: true } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    other.setTools([{ name: "browser_navigate" }, { name: "browser_click" }]);
    await harness.session.refreshMcp();

    // The sub-agent's tool list used to be captured when the session started,
    // so a reconnect that added a browser tool never reached it.
    const tools = harness.session.browserToolsForTest();

    expect(tools.map((tool) => (tool as { name: string }).name)).toContain(
      "browser_click"
    );
  });
});
