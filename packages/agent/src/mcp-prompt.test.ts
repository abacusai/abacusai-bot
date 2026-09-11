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
  it("names a server the model can call, with its tool count", () => {
    expect(mcpPrompt([server({})])).toMatch(/`abacus-connectors` \(3 tools/);
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

  it("leaves the app's own servers out", () => {
    expect(mcpPrompt([server({ isBuiltin: true })])).toBeNull();
  });
});

describe("the roster fingerprint", () => {
  it("changes when a server gains a tool, and not with order", () => {
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
    expect(reordered).toBe(before);
    expect(grown).not.toBe(before);
  });

  it("ignores the app's own servers", () => {
    expect(mcpRosterFingerprint([server({ isBuiltin: true })])).toBe("");
  });
});
