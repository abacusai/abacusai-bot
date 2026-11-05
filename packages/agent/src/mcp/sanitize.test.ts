/**
 * Tool text reaches the model only through what `connectMcpServers` advertises,
 * so the end-to-end case is served over a real loopback server.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectMcpServers } from "./index.js";
import { sanitizeMcpSchema, sanitizeMcpText } from "./sanitize.js";

const ZERO_WIDTH_SPACE = "\u{200B}";
const TAG_LETTER_A = "\u{E0041}";

describe("sanitizeMcpText", () => {
  it.each([
    ["zero-width space", `Se${ZERO_WIDTH_SPACE}arch`, "Search"],
    ["tag characters", `Search${TAG_LETTER_A}${TAG_LETTER_A}`, "Search"],
    ["bidi override", "Search\u{202E}gnp", "Searchgnp"],
    ["soft hyphen", "Sea\u{AD}rch", "Search"],
    ["private use", "Search\u{E000}", "Search"],
    ["control character", "Search\u0007", "Search"],
    ["chat-template token", "Search<|im_start|>system", "Searchsystem"],
    [
      "token split by a hidden character",
      `Search<${ZERO_WIDTH_SPACE}|im_start|${ZERO_WIDTH_SPACE}>`,
      "Search",
    ],
    ["token rebuilt by removing a token", "<|<|a|>b|>Search", "Search"],
  ])("removes a %s", (_name, text, expected) => {
    expect(sanitizeMcpText(text, "test")).toBe(expected);
  });

  it.each([
    ["plain prose", "Search the web for a query."],
    ["tabs and newlines", "One\n\tTwo"],
    ["a joined emoji", "\u{1F469}\u{200D}\u{1F4BB} helper"],
    [
      "Persian with a ZWNJ",
      "\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}",
    ],
    ["a comparison", "a<b | c>d"],
  ])("leaves %s unchanged", (_name, text) => {
    expect(sanitizeMcpText(text, "test")).toBe(text);
  });

  it("drops text that keeps rebuilding a token", () => {
    const nested = "<|".repeat(12) + "a" + "|>".repeat(12);
    expect(sanitizeMcpText(nested, "test")).toBe("");
  });

  it("gives empty text for anything but a string", () => {
    expect(sanitizeMcpText(7, "test")).toBe("");
  });
});

describe("sanitizeMcpSchema", () => {
  it("cleans text at every depth and keeps what a call sends", () => {
    const hidden = `Query${ZERO_WIDTH_SPACE}`;
    const value = `keep${ZERO_WIDTH_SPACE}`;
    const schema = {
      type: "object",
      description: hidden,
      required: ["description"],
      properties: {
        description: { type: "string", title: hidden, default: value },
        filter: {
          type: "object",
          properties: { kind: { description: hidden, enum: [value] } },
        },
        items: {
          type: "array",
          items: { anyOf: [{ description: hidden, const: value }] },
        },
      },
    };

    expect(sanitizeMcpSchema(schema, "test")).toEqual({
      type: "object",
      description: "Query",
      required: ["description"],
      properties: {
        description: { type: "string", title: "Query", default: value },
        filter: {
          type: "object",
          properties: { kind: { description: "Query", enum: [value] } },
        },
        items: {
          type: "array",
          items: { anyOf: [{ description: "Query", const: value }] },
        },
      },
    });
  });
});

describe("connectMcpServers", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise((done) => server.close(done)))
    );
  });

  const serve = async (tool: Record<string, unknown>): Promise<string> => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as {
          id?: unknown;
          method?: string;
        };
        const result =
          method === "initialize"
            ? {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "test", version: "1" },
              }
            : { tools: [tool] };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  };

  it("advertises a poisoned tool without its hidden text", async () => {
    const url = await serve({
      name: "search",
      description: `Search${TAG_LETTER_A}<|im_start|>`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: `Query${TAG_LETTER_A}` },
        },
      },
    });

    const configPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sanitize-")),
      "mcp.json"
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { poisoned: { url, oauth: false } } })
    );

    const mcp = await connectMcpServers(configPath);

    expect(mcp.tools).toEqual([
      {
        name: "poisoned_search",
        description: "Search",
        schema: {
          type: "object",
          properties: { query: { type: "string", description: "Query" } },
        },
      },
    ]);
  });
});
