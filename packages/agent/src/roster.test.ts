/**
 * The roster, checked without a session: every tool this process can
 * register has an off switch in the Capabilities registry and a pinned
 * permission decision. tool-roster.e2e.test.ts proves the same against a
 * running host; this catches the miss at the table, seconds after it is
 * made, with nothing to build.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TOOL_NAME_ALIASES } from "./excluded-tools.js";
import {
  buildRoster,
  NOT_SWITCHABLE,
  OWN_TOOLS,
  ROSTER_TOOL_NAMES,
  SUB_AGENT_TOOLS,
  type RosterContext,
} from "./roster.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const TOOLSETS = fs.readFileSync(
  path.join(REPO_ROOT, "apps", "desktop", "src", "shared", "toolsets.ts"),
  "utf8"
);
const GATE_ROSTER = fs.readFileSync(
  path.join(HERE, "gate-roster.test.ts"),
  "utf8"
);

describe("the roster table", () => {
  it("names each tool once", () => {
    expect(new Set(ROSTER_TOOL_NAMES).size).toBe(ROSTER_TOOL_NAMES.length);
  });

  it("is switchable from the Capabilities pane, tool by tool", () => {
    // Through the same alias the exclude list uses: the registry says `glob`
    // where pi says `find`, and both halves already agree on that.
    const unswitchable = ROSTER_TOOL_NAMES.map(
      (tool) => TOOL_NAME_ALIASES[tool] ?? tool
    ).filter(
      (tool) =>
        !NOT_SWITCHABLE.includes(tool) &&
        !new RegExp(`['"]${tool}['"]`).test(TOOLSETS)
    );

    expect(unswitchable).toEqual([]);
  });

  it("has a pinned permission decision for every tool", () => {
    const unpinned = ROSTER_TOOL_NAMES.filter(
      (tool) =>
        !NOT_SWITCHABLE.includes(tool) &&
        !new RegExp(`name: ['"]${tool}['"]`).test(GATE_ROSTER)
    );

    expect(unpinned).toEqual([]);
  });

  it("keeps the not-switchable list to tools that are in the table", () => {
    for (const name of NOT_SWITCHABLE) {
      expect(ROSTER_TOOL_NAMES).toContain(name);
    }
  });
});

describe("building the roster", () => {
  const context = (provided: string[]): RosterContext =>
    ({
      cwd: "/tmp/roster-ws",
      agentDir: "/tmp/roster-agent",
      modelRuntime: {} as never,
      subAgentSettingsManager: {} as never,
      model: undefined,
      browserModel: undefined,
      hostServices: null,
      excluded: [],
      operations: {} as never,
      mcp: () => ({ tools: [], clients: [], statuses: [] }) as never,
      provided: new Set(provided),
      mode: () => "normal" as never,
      sessionId: () => undefined,
      emit: () => undefined,
      reloadSkills: () => undefined,
    }) as RosterContext;

  it("registers a tool nothing else provides, and skips one something does", () => {
    const names = (roster: { tools: { name: string }[] }): string[] =>
      roster.tools.map((tool) => tool.name);

    const bare = names(buildRoster(context([]), () => false));
    expect(bare).toEqual(expect.arrayContaining(["todo", "memory", "serve"]));

    const served = names(buildRoster(context(["todo", "memory"]), () => false));
    expect(served).not.toContain("todo");
    expect(served).not.toContain("memory");
    expect(served).toContain("serve");
  });

  it("keeps the always-on tools whatever is provided", () => {
    const roster = buildRoster(
      context([...OWN_TOOLS, ...SUB_AGENT_TOOLS].map((e) => e.name)),
      () => false
    );
    const names = roster.tools.map((tool) => tool.name);

    for (const name of NOT_SWITCHABLE) expect(names).toContain(name);
    expect(names).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
  });

  it("withholds nothing behind a host service when there is none", () => {
    const names = buildRoster(context([]), () => false).tools.map(
      (tool) => tool.name
    );

    for (const name of ["document", "design", "ppt"]) {
      expect(names).not.toContain(name);
    }
  });
});
