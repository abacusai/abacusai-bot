/**
 * The connected-services line, and the fingerprint that decides when the
 * prompt carrying it is stale. A server with no tools must not be announced
 * as a service the model can call: "(0 tools)" read as "no integration",
 * and the Slack tool that arrived a minute later was disbelieved.
 */
import { describe, expect, it } from "vitest";

import type { McpServerStatus } from "./mcp/index.js";
import { mcpPrompt, mcpRosterFingerprint } from "./session.js";

const server = (over: Partial<McpServerStatus>): McpServerStatus => ({
  id: "abacus-connectors",
  name: "abacus-connectors",
  transport: "http",
  status: "connected",
  toolCount: 3,
  ...over,
});

describe("the connected-services line", () => {
  it("names a server the model can call, without a count that would churn the prompt", () => {
    expect(mcpPrompt([server({})])).toContain(
      "`abacus-connectors` (tools named `abacus-connectors_*`)"
    );
    expect(mcpPrompt([server({ toolCount: 7 })])).toBe(mcpPrompt([server({})]));
  });

  it("says nothing about a connected server that has no tools yet", () => {
    expect(mcpPrompt([server({ toolCount: 0 })])).toBeNull();
    expect(
      mcpPrompt([
        server({ toolCount: 0 }),
        server({ id: "notion", name: "notion" }),
      ])
    ).not.toMatch(/abacus-connectors/);
  });

  it("says an app's own server with no tools yet is waiting on its app, and drops that once it serves", () => {
    const studio = (toolCount: number) =>
      server({
        id: "roblox-studio",
        name: "roblox-studio",
        transport: "stdio",
        toolCount,
      });
    expect(mcpPrompt([studio(0)])).toContain(
      "Connected, but serving no tools yet: `roblox-studio`"
    );
    expect(mcpPrompt([studio(0)])).toContain(
      "Its tools join your list by themselves"
    );
    expect(mcpPrompt([studio(10)])).not.toContain("serving no tools yet");
  });

  it("leaves the app's own servers out", () => {
    expect(mcpPrompt([server({ isBuiltin: true })])).toBeNull();
  });
});

describe("the roster fingerprint", () => {
  it("changes when a server gets its first tool, not with a count or order", () => {
    const before = mcpRosterFingerprint([
      server({ toolCount: 2 }),
      server({ id: "notion", name: "notion", toolCount: 42 }),
    ]);
    const reordered = mcpRosterFingerprint([
      server({ id: "notion", name: "notion", toolCount: 42 }),
      server({ toolCount: 2 }),
    ]);
    const grown = mcpRosterFingerprint([
      server({ toolCount: 3 }),
      server({ id: "notion", name: "notion", toolCount: 42 }),
    ]);
    const empty = mcpRosterFingerprint([
      server({ toolCount: 0 }),
      server({ id: "notion", name: "notion", toolCount: 42 }),
    ]);
    expect(reordered).toBe(before);
    expect(grown).toBe(before);
    expect(empty).not.toBe(before);
  });

  it("ignores the app's own servers", () => {
    expect(mcpRosterFingerprint([server({ isBuiltin: true })])).toBe("");
  });
});
