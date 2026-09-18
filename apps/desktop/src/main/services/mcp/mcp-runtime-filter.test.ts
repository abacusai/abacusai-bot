/**
 * The runtime MCP config carries every user server for every session — bots
 * included. The per-bot connector grant that used to filter this file is
 * gone: a bot that needs a service asks for it with connect_connector, and
 * the Connect button is the gate. Its own file because the service resolves
 * the home directory at import time, so these tests re-import the module
 * against a temporary home.
 */
import { describe, expect, it } from "vitest";

import { useTempBotHome, writtenServers } from "./mcp-test-home";

const home = useTempBotHome({
  mcpServers: {
    linear: { url: "http://localhost:11" },
    notion: { url: "http://localhost:12" },
    "abacus-connectors": { url: "http://localhost:13" },
  },
});

describe("the runtime config a session spawns with", () => {
  it("carries every user server, plus the builtins", async () => {
    const service = await home.loadService();

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
