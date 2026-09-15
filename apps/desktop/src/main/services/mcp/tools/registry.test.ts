/**
 * The three places a served tool has to agree: its definition here, the
 * `TOOLSETS` registry the Capabilities pane and the exclude list are built
 * from, and the description strings the pane shows. They used to be kept in
 * step by hand, and `design` and `deck_export_pdf` once shipped with a
 * definition and no registry entry — advertised nowhere, callable by nothing,
 * and no test noticed. So the agreement is asserted, not trusted.
 */
import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import { TOOLSETS } from "#shared/toolsets";

import { AGENT_TOOL_NAMES, AGENT_TOOLS, agentTool } from "./index";

/**
 * Served, switchable, and deliberately absent from the registry. Each needs
 * a reason, because the registry is where a user looks for an off switch.
 *
 * `my_activity` answers only a bot's own chat about that bot's other
 * conversations; it grants nothing and there is nothing for a user to switch.
 */
const NOT_IN_REGISTRY = new Set(["my_activity"]);

const registryTools = new Map<string, { toolset: string; agent: boolean }>();
for (const set of TOOLSETS) {
  for (const entry of set.tools) {
    registryTools.set(entry.name, {
      toolset: set.id,
      agent: entry.agentDelivered === true,
    });
  }
}

const readyToolsetIds = new Set(
  TOOLSETS.filter((set) => set.status === "ready").map((set) => set.id)
);

const descriptions = (
  JSON.parse(
    fs.readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "renderer",
        "locales",
        "en-US.json"
      ),
      "utf8"
    )
  ) as { capabilities: { toolDescriptions: Record<string, string> } }
).capabilities.toolDescriptions;

describe("every served tool", () => {
  it("has one definition", () => {
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOL_NAMES.length);
    for (const name of AGENT_TOOL_NAMES) {
      expect(agentTool(name)?.name).toBe(name);
    }
  });

  it("names only toolsets that exist and are ready", () => {
    for (const definition of AGENT_TOOLS) {
      if (definition.toolsets === "always") continue;
      expect(definition.toolsets.length, definition.name).toBeGreaterThan(0);
      for (const toolset of definition.toolsets) {
        expect(
          readyToolsetIds.has(toolset),
          `${definition.name}: ${toolset}`
        ).toBe(true);
      }
    }
  });

  it("is in the Capabilities registry unless it is hidden from the model", () => {
    // A hidden tool is one the model is never told about, so a registry row
    // would advertise something the pane cannot deliver. Everything else the
    // model can see needs its off switch.
    const missing = AGENT_TOOLS.filter(
      (definition) =>
        definition.hidden !== true &&
        !NOT_IN_REGISTRY.has(definition.name) &&
        !registryTools.has(definition.name)
    ).map((definition) => definition.name);

    expect(missing).toEqual([]);
  });

  it("is listed in the registry under a toolset that can actually turn it on", () => {
    // The registry says which switch a tool sits behind; the definition says
    // which switch the server checks. A tool filed under the wrong group in
    // either place is a switch that does nothing.
    for (const definition of AGENT_TOOLS) {
      const row = registryTools.get(definition.name);
      if (row == null || definition.toolsets === "always") continue;
      expect(definition.toolsets, definition.name).toContain(row.toolset);
    }
  });

  it("is not both hidden and in the registry", () => {
    for (const definition of AGENT_TOOLS) {
      if (definition.hidden === true)
        expect(registryTools.has(definition.name), definition.name).toBe(false);
    }
  });
});

describe("the Capabilities registry", () => {
  it("names no MCP agent tool the server does not serve", () => {
    // The reverse direction: a registry row with nothing behind it is a
    // switch that lies, and a description of a tool nobody can call.
    const phantom = [...registryTools.entries()]
      .filter(
        ([name, row]) =>
          !row.agent &&
          TOOLSETS.find((set) => set.id === row.toolset)?.delivery ===
            "mcp-agent-tools" &&
          agentTool(name) == null
      )
      .map(([name]) => name);

    expect(phantom).toEqual([]);
  });

  it("has a description for every tool it lists, and no orphans", () => {
    const listed = new Set(
      TOOLSETS.flatMap((set) => set.tools.map((t) => t.descriptionKey))
    );
    const undescribed = [...listed].filter((key) => descriptions[key] == null);
    const orphaned = Object.keys(descriptions).filter(
      (key) => !listed.has(key)
    );

    expect(undescribed).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});
