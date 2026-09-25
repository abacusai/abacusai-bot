/**
 * The registry behind the Capabilities tab.
 *
 * Nothing in src/shared had tests, and this is the file in it with the most
 * reach: it decides which tools the model is told about, on both the desktop and
 * the CLI. The failures it can produce are quiet ones (a tool withheld from a
 * group the user switched on, or a default that drifts away from what the docs
 * promise), so the invariants are asserted here rather than trusted.
 */
import { describe, expect, it } from "vitest";

import {
  excludedBuiltinTools,
  isToolsetEnabled,
  READY_TOOL_COUNT,
  TOOLSETS,
} from "./toolsets";

describe("whether a group is on", () => {
  it("uses the group default when the user has expressed no preference", () => {
    expect(isToolsetEnabled("file", undefined)).toBe(true);
    expect(isToolsetEnabled("device", undefined)).toBe(false);
    expect(isToolsetEnabled("file", {})).toBe(true);
  });

  it("lets a stored preference override the default in both directions", () => {
    expect(isToolsetEnabled("file", { file: false })).toBe(false);
    expect(isToolsetEnabled("device", { device: true })).toBe(true);
  });

  it("never reports a planned group as on, whatever is stored", () => {
    // There is nothing behind the switch. Saying otherwise is a lie the rest of
    // the app then has to carry.
    const planned = TOOLSETS.filter((set) => set.status === "planned");

    expect(planned.length).toBeGreaterThan(0);
    for (const set of planned) {
      expect(isToolsetEnabled(set.id, { [set.id]: true })).toBe(false);
    }
  });

  it("reports an unknown id as off rather than throwing", () => {
    expect(isToolsetEnabled("not-a-group", { "not-a-group": true })).toBe(
      false
    );
  });
});

describe("what gets withheld from the model", () => {
  it("withholds a switched-off builtin group", () => {
    expect(excludedBuiltinTools({ terminal: false })).toContain("bash");
  });

  it("withholds nothing from a group that is on", () => {
    expect(excludedBuiltinTools({ terminal: true })).not.toContain("bash");
  });

  it("never names an MCP-delivered tool", () => {
    // Those are withheld by not connecting the server. Listing them here would
    // imply a second enforcement point that does not exist, and the first
    // person to rely on it would be wrong.
    const mcpOnly = new Set(
      TOOLSETS.filter(
        (set) => set.delivery?.startsWith("mcp-") === true
      ).flatMap((set) =>
        set.tools.filter((t) => t.agentDelivered !== true).map((t) => t.name)
      )
    );
    const everythingOff = Object.fromEntries(
      TOOLSETS.map((set) => [set.id, false])
    );

    for (const name of excludedBuiltinTools(everythingOff)) {
      expect(
        mcpOnly.has(name),
        `${name} is MCP-delivered and must not be excluded by name`
      ).toBe(false);
    }
  });

  it("does not withhold a tool that another enabled group also provides", () => {
    // The trap: a name listed under two groups is excluded if *either* is off,
    // so a user turning one off silently loses it from the one still on. No
    // excludable tool is currently shared, and this asserts it stays that way.
    const excludable = new Map<string, string[]>();

    for (const set of TOOLSETS) {
      for (const entry of set.tools) {
        if (set.delivery !== "builtin" && entry.agentDelivered !== true)
          continue;
        excludable.set(entry.name, [
          ...(excludable.get(entry.name) ?? []),
          set.id,
        ]);
      }
    }

    for (const [name, groups] of excludable) {
      expect(
        groups,
        `${name} is excludable and listed in more than one group`
      ).toHaveLength(1);
    }
  });
});

describe("the count on the tab", () => {
  it("counts distinct tools, not listings", () => {
    // present_deliverable appears under every group that produces something to
    // hand over; counting it once per listing puts a number on the tab that the
    // list beneath it does not add up to.
    const listings = TOOLSETS.filter((set) => set.status === "ready").flatMap(
      (set) => set.tools
    );

    expect(READY_TOOL_COUNT).toBeLessThan(listings.length);
    expect(READY_TOOL_COUNT).toBe(new Set(listings.map((t) => t.name)).size);
  });
});

describe("the defaults the docs promise", () => {
  it("ships Devices off, because its tools need a toolchain to exist", () => {
    expect(isToolsetEnabled("device", undefined)).toBe(false);
  });

  it("ships Cron on, so a schedule asked for in chat can be made", () => {
    expect(isToolsetEnabled("cronjob", undefined)).toBe(true);
  });

  it("ships the groups needing a credential off", () => {
    // docs/capabilities.md lists these as the off-by-default set. A group
    // quietly flipping on is a tool the user was never told they had.
    for (const id of [
      "homeassistant",
      "image_gen",
      "tts",
      "video",
      "video_gen",
      "bfl",
    ]) {
      expect(isToolsetEnabled(id, undefined), id).toBe(false);
    }
  });

  it("ships the everyday groups on", () => {
    for (const id of [
      "file",
      "terminal",
      "todo",
      "x_search",
      "memory",
      "skills",
      "web",
    ]) {
      expect(isToolsetEnabled(id, undefined), id).toBe(true);
    }
  });
});

/**
 * A tool the agent registers but the session then excludes is invisible from
 * the outside: the model simply never sees it, and the failure looks like the
 * model choosing not to use it. That has shipped here before: the sandboxed
 * `bash` was registered and excluded under the same name, and every macOS
 * session answered a shell call with "Tool bash not found".
 *
 * So each file tool is pinned to reaching the model under default preferences,
 * and to disappearing only when the group it belongs to is switched off.
 */
describe("the file tools reach the model", () => {
  const FILE_TOOLS = [
    "read",
    "batch_file_read",
    "write",
    "edit",
    "batch_edit",
    "ast_edit",
    "code_map",
  ];

  it.each(FILE_TOOLS)("does not withhold %s by default", (name) => {
    expect(excludedBuiltinTools(undefined)).not.toContain(name);
  });

  it.each(FILE_TOOLS)(
    "withholds %s when the file group is switched off",
    (name) => {
      expect(excludedBuiltinTools({ file: false })).toContain(name);
    }
  );

  it("keeps the file group on by default", () => {
    expect(isToolsetEnabled("file", undefined)).toBe(true);
  });
});

/**
 * The tools the session registers whatever the toggles say.
 *
 * `background`, `read_output` and `exit_plan_mode` reached the model for months
 * without appearing in this registry at all: they are registered by extensions
 * the session always loads, so nothing here listed them and the Capabilities
 * panel could not show them. A tool the model can call has to be findable, and
 * the panel is where people look.
 *
 * They are listed as always-on rather than switchable because none of them is a
 * capability to opt into. `bash` takes `background: true` whatever is set here,
 * so withholding the background tools would strand jobs the agent can start and
 * then neither read nor stop; `read_output` is the other half of a truncation
 * notice; and plan mode is a mode, so the way out of it cannot depend on a
 * toolset.
 */
describe("the always-on tools are in the registry", () => {
  const ALWAYS_ON_TOOLS = [
    "fetch_background_output",
    "kill_process",
    "read_output",
    "exit_plan_mode",
  ];

  it.each(ALWAYS_ON_TOOLS)("lists %s, so the panel can show it", (name) => {
    const owner = TOOLSETS.find((set) =>
      set.tools.some((entry) => entry.name === name)
    );

    expect(
      owner,
      `${name} is registered by the agent but named in no toolset`
    ).toBeDefined();
    expect(owner?.alwaysOn).toBe(true);
  });

  it.each(ALWAYS_ON_TOOLS)(
    "never withholds %s, whatever is switched off",
    (name) => {
      expect(excludedBuiltinTools(undefined)).not.toContain(name);
      expect(
        excludedBuiltinTools({ process: false, plan_mode: false })
      ).not.toContain(name);
    }
  );

  /**
   * The switch does not exist, so a stored `false` is stale state or a
   * hand-edited settings file. Reading it as "off" would put these tools in
   * `excludeTools` while the panel went on showing them as on, and because the
   * agent registers them itself, that withholds them for real.
   */
  it.each(["process", "plan_mode"])(
    "reports %s on even when a preference says otherwise",
    (id) => {
      expect(isToolsetEnabled(id, { [id]: false })).toBe(true);
    }
  );
});
