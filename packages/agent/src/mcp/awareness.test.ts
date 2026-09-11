/**
 * The model has to know which services it is connected to.
 *
 * Reported: a Playwright connector was added in the app, a new conversation was
 * started after that, and the agent still answered that it was not connected —
 * it used the tools only once the user named the server themselves. The tools
 * were in the roster the whole time. A list of tool names says a call is
 * possible; it does not say that the service the user just asked about by name
 * is the thing behind it, so the connection is now stated outright.
 */
import { describe, expect, it } from "vitest";

import { mcpPrompt } from "../session.js";
import type { McpServerStatus } from "./index.js";

const status = (
  over: Partial<McpServerStatus> & { name: string }
): McpServerStatus => ({
  id: over.name,
  transport: "http",
  status: "connected",
  toolCount: 1,
  ...over,
});

describe("what the session says it is connected to", () => {
  it("names every connected server, with the prefix its tools carry", () => {
    const prompt = mcpPrompt([
      status({ name: "playwright", toolCount: 24 }),
      status({ name: "github", toolCount: 12 }),
    ]);

    expect(prompt).toContain("`playwright` (24 tools, named `playwright_*`)");
    expect(prompt).toContain("`github` (12 tools, named `github_*`)");
    expect(prompt).toContain(
      "do not say you lack an integration that is named here"
    );
  });

  it("counts one tool as one tool", () => {
    expect(mcpPrompt([status({ name: "docs", toolCount: 1 })])).toContain(
      "(1 tool, named"
    );
  });

  it("says which servers need a sign-in, instead of leaving them out", () => {
    const prompt = mcpPrompt([
      status({ name: "notion", status: "auth-required" }),
    ]);

    expect(prompt).toContain("`notion` (needs a sign-in in the app)");
    expect(prompt).toContain("configured but not usable");
  });

  it("carries a failed server’s own error", () => {
    const prompt = mcpPrompt([
      status({ name: "internal", status: "error", error: "ECONNREFUSED" }),
    ]);

    expect(prompt).toContain("`internal` (ECONNREFUSED)");
  });

  it("leaves out the app’s own built-ins, which are described elsewhere", () => {
    const prompt = mcpPrompt([
      status({ name: "browser", isBuiltin: true }),
      status({ name: "agent-tools", isBuiltin: true, toolCount: 30 }),
      status({ name: "playwright", toolCount: 24 }),
    ]);

    expect(prompt).toContain("playwright");
    expect(prompt).not.toContain("browser");
    expect(prompt).not.toContain("agent-tools");
  });

  it("says nothing at all when the user has no servers", () => {
    expect(mcpPrompt([])).toBeNull();
    expect(
      mcpPrompt([status({ name: "browser", isBuiltin: true })])
    ).toBeNull();
  });

  it("says nothing about a server the user switched off", () => {
    expect(
      mcpPrompt([
        status({
          name: "paused",
          status: "disconnected",
          transport: "disabled",
          toolCount: 0,
        }),
      ])
    ).toBeNull();
  });
});
