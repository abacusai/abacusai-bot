/**
 * McpToolSync: the tools the model sees change only between runs. A change
 * landing under a running turn (a refresh main gave up waiting on, a server
 * recovering late through `onToolsAdded`) waits: removals for the next turn
 * start, additions for one continuation at the turn's end.
 */
import { describe, expect, it } from "vitest";

import type { ConnectedMcp } from "./index.js";
import { McpToolSync } from "./tool-sync.js";

const mcpWith = (...names: string[]): ConnectedMcp =>
  ({
    clients: [],
    statuses: [],
    routes: new Map(),
    tools: names.map((name) => ({ name, description: name, schema: {} })),
  }) as unknown as ConnectedMcp;

const setup = (initial: string[]) => {
  let mcp = mcpWith(...initial);
  let running = false;
  const registered: string[] = [];
  let active: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => {
      registered.push(tool.name);
      active.push(tool.name);
    },
  };
  const session = {
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names: string[]) => {
      active = [...names];
    },
  };
  const sync = new McpToolSync({
    pi: () => pi as never,
    session: () => session,
    mcp: () => mcp,
    accepts: (tool) => !tool.name.startsWith("browser_"),
    turnRunning: () => running,
  });
  sync.changed();
  return {
    sync,
    active: () => active,
    registered,
    setMcp: (...names: string[]) => {
      mcp = mcpWith(...names);
    },
    setRunning: (value: boolean) => {
      running = value;
    },
  };
};

describe("McpToolSync", () => {
  it("applies a change between turns at once, additions and removals", () => {
    const t = setup(["gmail", "browser_open"]);
    expect(t.active()).toEqual(["gmail"]);
    t.setMcp("gmail", "drive");
    t.sync.changed();
    expect(t.active()).toEqual(["gmail", "drive"]);
    t.setMcp("drive");
    t.sync.changed();
    expect(t.active()).toEqual(["drive"]);
    t.setMcp("gmail", "drive");
    t.sync.changed();
    expect(t.active().sort()).toEqual(["drive", "gmail"]);
    // Registered once each; a returning tool is activated, not re-registered.
    expect(t.registered).toEqual(["gmail", "drive"]);
  });

  it("never changes the tools under a running turn; a late landing that adds tools asks for a continuation", () => {
    const t = setup(["gmail"]);
    t.setRunning(true);
    // A server recovering late (onToolsAdded), or a refresh main gave up on.
    t.setMcp("gmail", "drive", "calendar");
    t.sync.changed();
    expect(t.active()).toEqual(["gmail"]);
    expect(t.sync.pendingArrivals()).toEqual(["drive", "calendar"]);
    // The continuation, between the turn's runs.
    t.sync.applyDeferred();
    expect(t.active()).toEqual(["gmail", "drive", "calendar"]);
    expect(t.sync.pendingArrivals()).toEqual([]);
  });

  it("leaves a removal under a running turn for the next turn start, with no continuation", () => {
    const t = setup(["gmail", "drive"]);
    t.setRunning(true);
    t.setMcp("gmail");
    t.sync.changed();
    expect(t.active()).toEqual(["gmail", "drive"]);
    expect(t.sync.pendingArrivals()).toEqual([]);
    t.setRunning(false);
    t.sync.atTurnStart();
    expect(t.active()).toEqual(["gmail"]);
  });
});
