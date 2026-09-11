/**
 * The runtime MCP config carries every user server for every session — bots
 * included. The per-bot connector grant that used to filter this file is
 * gone: a bot that needs a service asks for it with connect_connector, and
 * the Connect button is the gate. Its own file because the service resolves
 * the home directory at import time, so these tests re-import the module
 * against a temporary home.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

const loadService = async () => {
  vi.resetModules();
  const { McpConfigService } = await import("./mcp-config-service");
  return new McpConfigService();
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runtime-filter-"));
  process.env.ABACUSAI_BOT_HOME = home;
  fs.writeFileSync(
    path.join(home, "mcp-code.json"),
    JSON.stringify({
      mcpServers: {
        linear: { url: "http://localhost:11" },
        notion: { url: "http://localhost:12" },
        "abacus-connectors": { url: "http://localhost:13" },
      },
    })
  );
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

const writtenServers = (filePath: string): string[] =>
  Object.keys(
    (
      JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      }
    ).mcpServers
  ).sort();

describe("the runtime config a session spawns with", () => {
  it("carries every user server, plus the builtins", async () => {
    const service = await loadService();

    const filePath = service.writeRuntimeMcp(
      "code",
      { browser: { url: "http://localhost:9" } },
      "session-1"
    );

    expect(writtenServers(filePath)).toEqual([
      "abacus-connectors",
      "browser",
      "linear",
      "notion",
    ]);
  });
});
