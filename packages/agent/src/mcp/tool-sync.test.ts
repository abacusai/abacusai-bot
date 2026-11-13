import { GATEWAY_SERVER_NAME } from "@abacus-ai/connectors/registry";
/**
 * McpToolSync: the tools the model sees change only between runs. A change
 * landing under a running turn (a refresh main gave up waiting on, a server
 * recovering late through `onToolsAdded`) waits: removals for the next turn
 * start, additions for one continuation at the turn's end.
 */
import { describe, expect, it } from "vitest";

import type { ConnectedMcp } from "./index.js";
import { TOOL_SEARCH_NAME } from "./tool-search.js";
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

/**
 * Tool search: past the budget, the largest servers the user added wait
 * behind tool_search, and what a search finds is switched on under its own
 * name and stays on.
 */
describe("McpToolSync with tool search", () => {
  /** A server's tools; `big` gives each a schema large enough to pass the budget together. */
  const serverTools = (server: string, names: string[], big = false) =>
    names.map((name) => ({
      server,
      name: `${server}_${name}`,
      description: `${name.replace(/_/g, " ")} for the ${server} project`,
      schema: big
        ? {
            type: "object",
            properties: {
              notes: { type: "string", description: "x".repeat(4_000) },
            },
          }
        : { type: "object" },
    }));

  const userTools = [
    ...serverTools(
      "rea",
      Array.from({ length: 30 }, (_, i) => `step_${i}`).concat([
        "camera_pitch",
        "camera_height",
        "board_layout",
      ]),
      true
    ),
    ...serverTools("graphify", ["query_graph", "build_graph"]),
  ];

  const build = (
    tools: Array<{
      server: string;
      name: string;
      description: string;
      schema: Record<string, unknown>;
    }>
  ): ConnectedMcp => {
    const routes = new Map(
      tools.map((tool) => [
        tool.name,
        { client: { name: tool.server }, toolName: tool.name },
      ])
    );
    return {
      clients: [],
      statuses: [
        {
          id: "agent-tools",
          name: "agent-tools",
          transport: "http",
          status: "connected",
          toolCount: 1,
          isBuiltin: true,
        },
      ],
      routes,
      tools: tools.map(({ name, description, schema }) => ({
        name,
        description,
        schema,
      })),
    } as unknown as ConnectedMcp;
  };

  const base = [
    {
      server: "agent-tools",
      name: "todo",
      description: "todo list",
      schema: {},
    },
    {
      server: GATEWAY_SERVER_NAME,
      name: `${GATEWAY_SERVER_NAME}_gmail`,
      description: "gmail",
      schema: {},
    },
  ];

  const setupSearch = (
    tools = [...base, ...userTools],
    messages: unknown[] = []
  ) => {
    let mcp = build(tools);
    let running = false;
    const definitions = new Map<
      string,
      {
        execute: (
          ...args: unknown[]
        ) => Promise<{ content: Array<{ text: string }> }>;
      }
    >();
    let active: string[] = [];
    const pi = {
      registerTool: (tool: { name: string; execute: never }) => {
        definitions.set(tool.name, tool as never);
        if (!active.includes(tool.name)) active.push(tool.name);
      },
    };
    const session = {
      getActiveToolNames: () => [...active],
      setActiveToolsByName: (names: string[]) => {
        active = [...names];
      },
      messages,
    };
    const sync = new McpToolSync({
      pi: () => pi as never,
      session: () => session,
      mcp: () => mcp,
      accepts: () => true,
      turnRunning: () => running,
    });
    sync.changed();
    const search = async (query: string) =>
      (await definitions.get(TOOL_SEARCH_NAME)!.execute("call", { query }))
        .content[0]!.text;
    return {
      sync,
      search,
      active: () => active,
      definitions,
      setMcp: (next: typeof tools) => {
        mcp = build(next);
      },
      setRunning: (value: boolean) => {
        running = value;
      },
    };
  };

  it("offers every tool, and no tool_search, while servers the user added fit the budget", () => {
    const t = setupSearch([
      ...base,
      ...serverTools("graphify", ["query_graph"]),
    ]);
    expect(t.active().sort()).toEqual(
      ["abacus-connectors_gmail", "graphify_query_graph", "todo"].sort()
    );
    expect(t.definitions.has(TOOL_SEARCH_NAME)).toBe(false);
  });

  it("defers the largest server the user added, never a built-in or connector one", () => {
    const t = setupSearch();
    expect(t.active().sort()).toEqual(
      [
        `${GATEWAY_SERVER_NAME}_gmail`,
        "graphify_build_graph",
        "graphify_query_graph",
        TOOL_SEARCH_NAME,
        "todo",
      ].sort()
    );
    // Registered (so it can be switched on), not offered.
    expect(t.definitions.has("rea_camera_pitch")).toBe(true);
    const description = (
      t.definitions.get(TOOL_SEARCH_NAME) as unknown as { description: string }
    ).description;
    expect(description).toContain(
      "- rea (33): rea_board_layout, rea_camera_height, rea_camera_pitch"
    );
    expect(description).not.toContain("graphify");
  });

  it("switches on what a search finds, under its own name, and keeps it on", async () => {
    const t = setupSearch();
    const text = await t.search("camera pitch");
    expect(text).toContain("- rea_camera_pitch:");
    expect(t.active()).toContain("rea_camera_pitch");
    expect(t.active()).toContain("rea_camera_height");
    expect(t.active()).not.toContain("rea_board_layout");
    await t.search("select:rea_board_layout, rea_nope");
    expect(t.active()).toContain("rea_board_layout");
    // A later refresh keeps what was loaded, and only adds.
    t.sync.changed();
    for (const name of [
      "rea_camera_pitch",
      "rea_camera_height",
      "rea_board_layout",
    ])
      expect(t.active()).toContain(name);
    expect(t.active()).not.toContain("rea_step_3");
    expect(await t.search("nothing matches this")).toContain("No tool matched");
  });

  it("loads again what a resumed chat already called, so its tool list is the one it had", () => {
    const t = setupSearch(undefined, [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "rea_step_4", arguments: {} }],
      },
    ]);
    expect(t.active()).toContain("rea_step_4");
    expect(t.active()).not.toContain("rea_step_5");
  });

  it("names tool_search, not the deferred tools, when they arrive under a running turn", () => {
    const t = setupSearch([...base]);
    expect(t.active()).not.toContain(TOOL_SEARCH_NAME);
    t.setRunning(true);
    t.setMcp([...base, ...userTools]);
    t.sync.changed();
    expect(t.sync.pendingArrivals().sort()).toEqual(
      ["graphify_build_graph", "graphify_query_graph", TOOL_SEARCH_NAME].sort()
    );
    t.sync.applyDeferred();
    expect(t.active()).toContain(TOOL_SEARCH_NAME);
    expect(t.active()).not.toContain("rea_step_1");
  });

  it("registers tool_search again on a fresh session, keeping what was loaded", async () => {
    const t = setupSearch();
    await t.search("select:rea_step_7");
    t.definitions.clear();
    t.sync.rebind(new Set(["todo"]));
    expect(t.definitions.has(TOOL_SEARCH_NAME)).toBe(true);
    expect(t.active()).toContain("rea_step_7");
    expect(t.active()).not.toContain("rea_step_8");
  });
});
