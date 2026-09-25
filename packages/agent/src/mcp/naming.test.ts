import fs from "node:fs";
/**
 * What the model is allowed to call.
 *
 * A component ends by telling the model "Hand it over: present_deliverable
 * with <url>". If the registered name is anything else, that instruction is a
 * lie and the run ends on a failed tool call. That is what happened, because
 * every MCP tool was prefixed with its server and the only registered name was
 * `agent-tools_present_deliverable`.
 *
 * Served over a real loopback HTTP server rather than a stubbed client: the
 * naming happens during connect, and a stub would let the bug back in by
 * agreeing with whatever the code does.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectMcpServers } from "./index.js";

interface Served {
  url: string;
  close: () => Promise<void>;
}

/** A minimal MCP server over HTTP, offering exactly the tool names given. */
const serve = async (toolNames: string[]): Promise<Served> => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      let id: unknown = null;
      let method = "";
      try {
        const parsed = JSON.parse(body) as { id?: unknown; method?: string };
        id = parsed.id ?? null;
        method = parsed.method ?? "";
      } catch {
        /* fall through to an empty result */
      }

      const result =
        method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            }
          : method === "tools/list"
            ? {
                tools: toolNames.map((name) => ({
                  name,
                  description: name,
                  inputSchema: { type: "object" },
                })),
              }
            : {};

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () =>
      await new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const written: string[] = [];

const configFor = (servers: Record<string, unknown>): string => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mcp-naming-")),
    "mcp.json"
  );
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), "utf8");
  written.push(file);
  return file;
};

afterEach(() => {
  for (const file of written.splice(0))
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

describe("MCP tool naming", () => {
  it("leaves a built-in server’s tools unprefixed", async () => {
    const served = await serve(["present_deliverable", "web_search"]);
    const mcp = await connectMcpServers(
      configFor({ "agent-tools": { url: served.url, isBuiltin: true } })
    );

    expect(mcp.tools.map((t) => t.name).sort()).toEqual([
      "present_deliverable",
      "web_search",
    ]);

    for (const client of mcp.clients) client.close?.();
    await served.close();
  });

  it("routes a built-in tool under both spellings", async () => {
    const served = await serve(["present_deliverable"]);
    const mcp = await connectMcpServers(
      configFor({ "agent-tools": { url: served.url, isBuiltin: true } })
    );

    // The advertised name, and the prefixed one anything older may still use.
    expect(mcp.routes.has("present_deliverable")).toBe(true);
    expect(mcp.routes.has("agent-tools_present_deliverable")).toBe(true);
    // Advertising both would double the tool list the model has to read.
    expect(mcp.tools).toHaveLength(1);

    for (const client of mcp.clients) client.close?.();
    await served.close();
  });

  it("still prefixes a third-party server, so two servers cannot collide", async () => {
    const first = await serve(["search"]);
    const second = await serve(["search"]);
    const mcp = await connectMcpServers(
      configFor({ alpha: { url: first.url }, beta: { url: second.url } })
    );

    expect(mcp.tools.map((t) => t.name).sort()).toEqual([
      "alpha_search",
      "beta_search",
    ]);
    expect(mcp.routes.get("alpha_search")?.toolName).toBe("search");
    expect(mcp.routes.get("beta_search")?.toolName).toBe("search");

    for (const client of mcp.clients) client.close?.();
    await first.close();
    await second.close();
  });

  it("does not double-prefix a built-in that already namespaces itself", async () => {
    const served = await serve(["browser_navigate"]);
    const mcp = await connectMcpServers(
      configFor({ browser: { url: served.url, isBuiltin: true } })
    );

    expect(mcp.tools.map((t) => t.name)).toEqual(["browser_navigate"]);

    for (const client of mcp.clients) client.close?.();
    await served.close();
  });
});
