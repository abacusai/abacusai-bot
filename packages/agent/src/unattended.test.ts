/**
 * The unattended mode: a routine nobody is watching. It never asks, and it
 * allows only what `UNATTENDED_TOOLS` names under its rule. Every tool the
 * agent can register is classified, so a new one is a decision, not a default.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchHostAllowlist,
  setCurrentMode,
  setUnattendedPolicy,
} from "./current-mode.js";
import {
  gateToolCall,
  parseModeStrict,
  type GateOptions,
} from "./permissions.js";
import { AgentMode, type AgentEvent, type ToolRequest } from "./protocol.js";
import { ROSTER_TOOL_NAMES } from "./roster.js";
import { AbacusBotSession } from "./session.js";
import {
  hostAllowed,
  parseUnattendedPolicy,
  UNATTENDED_BROWSER_TOOLS,
  UNATTENDED_CONNECTOR_READS,
  UNATTENDED_EXCLUDED_TOOLS,
  UNATTENDED_TOOLS,
  type ToolOrigin,
  type UnattendedPolicy,
} from "./tool-policy.js";

const WORKSPACE = "/tmp/routine-workspace";

const POLICY: UnattendedPolicy = {
  sourceHosts: ["news.example"],
  watchUrl: "https://shop.example/flight/123",
  watchPrompt: "is the price under 5000?",
};

const call = (name: string, input: Record<string, unknown> = {}): ToolRequest =>
  ({ id: "t1", name, type: name, input, args: input }) as ToolRequest;

const options = (
  overrides: {
    policy?: UnattendedPolicy | null;
    origin?: (name: string) => ToolOrigin;
  } = {}
): GateOptions => {
  const policy = overrides.policy === undefined ? POLICY : overrides.policy;
  return {
    mode: AgentMode.Unattended,
    cwd: WORKSPACE,
    allowedCommands: ["git status"],
    allowedTools: ["bash", "send_whatsapp_message"],
    allowedReadPaths: [],
    allowedWritePaths: [],
    allowedOrigins: ["https://attacker.example"],
    ...(policy != null
      ? {
          unattended: {
            policy,
            origin: overrides.origin ?? (() => "builtin" as const),
          },
        }
      : {}),
  };
};

const decide = (
  name: string,
  input: Record<string, unknown> = {},
  overrides?: Parameters<typeof options>[0]
): string => gateToolCall(call(name, input), options(overrides)).kind;

describe("the unattended gate", () => {
  it("never asks: every call is allowed or refused", () => {
    for (const name of [
      ...Object.keys(UNATTENDED_TOOLS),
      ...Object.keys(UNATTENDED_EXCLUDED_TOOLS),
      "something_new",
    ]) {
      expect(["allow", "refuse"]).toContain(
        decide(name, { url: "https://news.example/", path: "a.txt" })
      );
    }
  });

  it("allows the local, read-only tools", () => {
    for (const name of ["current_time", "todo", "skills_list", "skill_view"])
      expect(decide(name), name).toBe("allow");
    expect(decide("web_search", { query: "ai news" })).toBe("allow");
    expect(decide("x_search", { query: "ai news" })).toBe("allow");
  });

  it("reads inside the workspace only", () => {
    expect(decide("read", { path: "notes.md" })).toBe("allow");
    expect(decide("read", { path: "/etc/passwd" })).toBe("refuse");
    expect(decide("batch_file_read", { paths: ["a", "/etc/hosts"] })).toBe(
      "refuse"
    );
  });

  it.each([
    "bash",
    "write",
    "edit",
    "delete",
    "pdf",
    "cronjob",
    "memory",
    "serve",
    "delegate_task",
    "document",
    "browser_execute",
    "browser_vault_fill",
    "vault_items",
    "vault_request",
    "payment_approval",
    "send_whatsapp_message",
    "send_telegram_message",
    "send_discord_message",
    "send_chat_message",
    "ha_call_service",
    "ha_list_entities",
    "device_interact",
    "my_activity",
    "skill_manage",
    "image_generate",
  ])("refuses %s, whatever the session allowed before", (name) => {
    const gate = gateToolCall(
      call(name, { command: "git status", action: "start" }),
      options()
    );
    expect(gate.kind).toBe("refuse");
  });

  it("refuses a tool it has never heard of", () => {
    expect(decide("brand_new_tool")).toBe("refuse");
  });

  it("refuses everything when the run lost its policy", () => {
    expect(decide("current_time", {}, { policy: null })).toBe("refuse");
    expect(
      decide("web_fetch", { url: "https://news.example/" }, { policy: null })
    ).toBe("refuse");
  });

  it("refuses every tool from a server the user added, even one named like a built-in", () => {
    const user = (): ToolOrigin => "user";
    expect(decide("todo", { action: "list" }, { origin: user })).toBe("refuse");
    expect(
      decide("web_fetch", { url: "https://news.example/" }, { origin: user })
    ).toBe("refuse");
    expect(decide("mine_lookup", {}, { origin: user })).toBe("refuse");
  });

  it("allows the reviewed connector reads and nothing else from them", () => {
    const connector = (): ToolOrigin => "connector";
    expect(
      decide(
        "abacus-connectors_Gmail_Tool",
        { action: "search_email" },
        {
          origin: connector,
        }
      )
    ).toBe("allow");
    expect(
      decide(
        "Google_Calendar_Tool",
        { action: "search_event" },
        {
          origin: connector,
        }
      )
    ).toBe("allow");
    for (const action of ["send_email", "reply_to_email", "create_draft_email"])
      expect(
        decide(
          "abacus-connectors_Gmail_Tool",
          { action },
          { origin: connector }
        ),
        action
      ).toBe("refuse");
    expect(
      decide(
        "abacus-connectors_Google_Calendar_Tool",
        { action: "create_event" },
        {
          origin: connector,
        }
      )
    ).toBe("refuse");
    expect(
      decide(
        "abacus-connectors_Slack_Tool",
        { action: "search" },
        {
          origin: connector,
        }
      )
    ).toBe("refuse");
  });

  it("fetches the declared hosts only, matched exactly", () => {
    expect(decide("web_fetch", { url: "https://news.example/today" })).toBe(
      "allow"
    );
    expect(decide("web_fetch", { url: "https://NEWS.example./x" })).toBe(
      "allow"
    );
    for (const url of [
      "http://attacker.example/?d=secret",
      "https://attacker.news.example/",
      "https://news.example.attacker.example/",
      "https://169.254.169.254/latest/meta-data/",
      "not a url",
    ])
      expect(decide("web_fetch", { url }), url).toBe("refuse");
  });

  it("allows browser_task only for a routine that declared a watch page", () => {
    expect(decide("browser_task", { task: "search my email address" })).toBe(
      "allow"
    );
    expect(
      decide(
        "browser_task",
        { task: "x" },
        {
          policy: { sourceHosts: [], watchUrl: null },
        }
      )
    ).toBe("refuse");
  });
});

describe("every tool, classified", () => {
  /** The names the gate roster pins, the agent's own registry included. */
  const agentTools = (): string[] => {
    const roster = fs.readFileSync(
      path.join(import.meta.dirname, "gate-roster.test.ts"),
      "utf8"
    );
    const pinned = [...roster.matchAll(/name: ["']([a-z_]+)["']/g)].map(
      (match) => match[1]!
    );
    return [...new Set([...pinned, ...ROSTER_TOOL_NAMES])];
  };

  it("names every tool the agent registers as allowed or excluded", () => {
    const unclassified = agentTools().filter(
      (name) =>
        UNATTENDED_TOOLS[name] == null &&
        UNATTENDED_EXCLUDED_TOOLS[name] == null
    );
    expect(unclassified).toEqual([]);
  });

  it("never names a tool both ways", () => {
    const both = Object.keys(UNATTENDED_TOOLS).filter(
      (name) => UNATTENDED_EXCLUDED_TOOLS[name] != null
    );
    expect(both).toEqual([]);
  });

  it("gives every exclusion a reason", () => {
    for (const [name, reason] of Object.entries(UNATTENDED_EXCLUDED_TOOLS))
      expect(reason.length, name).toBeGreaterThan(5);
  });

  it("keeps the watch run's browser tools to opening and reading a page", () => {
    expect([...UNATTENDED_BROWSER_TOOLS].sort()).toEqual([
      "browser_navigate",
      "browser_snapshot",
    ]);
  });

  it("lists connector reads, never a send", () => {
    for (const actions of Object.values(UNATTENDED_CONNECTOR_READS))
      for (const action of actions)
        expect(action).not.toMatch(
          /send|reply|draft|create|delete|modify|move/
        );
  });
});

describe("hosts and the policy's wire form", () => {
  it("matches a host exactly", () => {
    expect(hostAllowed("news.example", ["news.example"])).toBe(true);
    expect(hostAllowed("www.news.example", ["news.example"])).toBe(false);
    expect(hostAllowed("news.example", ["*.example"])).toBe(false);
    expect(hostAllowed("", [""])).toBe(false);
  });

  it("parses the spawn flag, and nothing else", () => {
    expect(
      parseUnattendedPolicy(
        JSON.stringify({ sourceHosts: ["A.example", 3], watchUrl: "" })
      )
    ).toEqual({ sourceHosts: ["a.example"], watchUrl: null });
    expect(parseUnattendedPolicy("{nope")).toBeNull();
    expect(parseUnattendedPolicy(null)).toBeNull();
  });
});

describe("the mode itself", () => {
  afterEach(() => {
    setCurrentMode(AgentMode.Normal);
    setUnattendedPolicy(null);
  });

  it("is named on the wire", () => {
    expect(parseModeStrict("UNATTENDED")).toBe(AgentMode.Unattended);
  });

  it("holds web_fetch to the declared hosts, and nothing else", () => {
    setCurrentMode(AgentMode.Unattended);
    setUnattendedPolicy(POLICY);
    expect(fetchHostAllowlist()).toEqual(["news.example"]);
    setUnattendedPolicy(null);
    expect(fetchHostAllowlist()).toEqual([]);
    setCurrentMode(AgentMode.Yolo);
    expect(fetchHostAllowlist()).toBeNull();
  });

  it("is never left, and never entered after spawn", () => {
    const events: AgentEvent[] = [];
    const emit = (e: { type: string; event?: AgentEvent }): void => {
      if (e.type === "event" && e.event != null) events.push(e.event);
    };
    const unattended = new AbacusBotSession({
      cwd: "/tmp",
      mode: "UNATTENDED",
      unattended: POLICY,
      emit: emit as never,
    });
    unattended.setMode("YOLO");
    expect((unattended as unknown as { mode: AgentMode }).mode).toBe(
      AgentMode.Unattended
    );
    expect(fetchHostAllowlist()).toEqual(["news.example"]);

    const normal = new AbacusBotSession({
      cwd: "/tmp",
      mode: "DEFAULT",
      emit: emit as never,
    });
    normal.setMode("UNATTENDED");
    expect((normal as unknown as { mode: AgentMode }).mode).toBe(
      AgentMode.Normal
    );
    expect(fetchHostAllowlist()).toBeNull();
  });
});

describe("a held web_fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("node:dns/promises");
  });

  it("refuses a host off the list before any lookup", async () => {
    const { fetchUrl } = await import("./web/fetch.js");
    await expect(
      fetchUrl("https://attacker.invalid/?d=x", {
        allowedHosts: ["news.example"],
      })
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  it("refuses a declared host that resolves somewhere private", async () => {
    const { fetchUrl } = await import("./web/fetch.js");
    await expect(
      fetchUrl("http://127.0.0.1:9/", { allowedHosts: ["127.0.0.1"] })
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
    await expect(
      fetchUrl("http://10.0.0.1/", { allowedHosts: ["10.0.0.1"] })
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  it("checks every redirect hop by name before following it", async () => {
    vi.resetModules();
    const lookup = vi.fn(async (host: string) => {
      if (host !== "news.example") throw new Error(`looked up ${host}`);
      return [{ address: "93.184.216.34", family: 4 }];
    });
    vi.doMock("node:dns/promises", () => ({ lookup }));
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        fetched.push(String(url));
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/x?d=inbox" },
        });
      })
    );
    const { fetchUrl } = await import("./web/fetch.js");
    await expect(
      fetchUrl("https://news.example/r", { allowedHosts: ["news.example"] })
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
    expect(fetched).toEqual(["https://news.example/r"]);
    expect(lookup.mock.calls.map((args) => args[0])).toEqual(["news.example"]);
  });
});
