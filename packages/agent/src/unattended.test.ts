/**
 * The unattended mode: a routine nobody is watching. It never asks, and it
 * allows only what `UNATTENDED_TOOLS` names under its rule. Every tool the
 * agent can register is classified, so a new one is a decision, not a default.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchHold,
  markPrivateRead,
  setCurrentMode,
  setUnattendedPolicy,
} from "./current-mode.js";
import {
  gateToolCall,
  parseModeStrict,
  toolPath,
  type GateOptions,
} from "./permissions.js";
import { AgentMode, type AgentEvent, type ToolRequest } from "./protocol.js";
import { ROSTER_TOOL_NAMES } from "./roster.js";
import { AbacusBotSession } from "./session.js";
import {
  hostAllowed,
  isMultiTenantHost,
  sourceAllows,
  parseUnattendedPolicy,
  UNATTENDED_BROWSER_TOOLS,
  UNATTENDED_CONNECTOR_READS,
  UNATTENDED_EXCLUDED_TOOLS,
  UNATTENDED_TOOLS,
  type ToolOrigin,
  type UnattendedPolicy,
} from "./tool-policy.js";
import { collectFiles } from "./workspace-scan.js";

const WORKSPACE = "/tmp/routine-workspace";

const POLICY: UnattendedPolicy = {
  sources: ["https://news.example/"],
  connectorReads: { Gmail_Tool: ["search_email"] },
  watchUrl: "https://shop.example/flight/123",
  watchPrompt: "is the price under 5000?",
};

const call = (name: string, input: Record<string, unknown> = {}): ToolRequest =>
  ({ id: "t1", name, type: name, input, args: input }) as ToolRequest;

const options = (
  overrides: {
    policy?: UnattendedPolicy | null;
    origin?: (name: string) => ToolOrigin;
    held?: boolean;
    allowedReadPaths?: string[];
  } = {}
): GateOptions => {
  const policy = overrides.policy === undefined ? POLICY : overrides.policy;
  return {
    mode: AgentMode.Unattended,
    cwd: WORKSPACE,
    allowedCommands: ["git status"],
    allowedTools: ["bash", "send_whatsapp_message"],
    allowedReadPaths: overrides.allowedReadPaths ?? [],
    allowedWritePaths: [],
    allowedOrigins: ["https://attacker.example"],
    ...(policy != null
      ? {
          unattended: {
            policy,
            origin: overrides.origin ?? (() => "builtin" as const),
            held: overrides.held === true,
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

  it("allows only the connector reads this routine was given, and never a write", () => {
    const connector = (): ToolOrigin => "connector";
    const gmail = (action: string, policy?: UnattendedPolicy) =>
      decide(
        "abacus-connectors_Gmail_Tool",
        { action },
        { origin: connector, ...(policy != null ? { policy } : {}) }
      );
    expect(gmail("search_email")).toBe("allow");
    // Reviewed as a read, but not given to this routine.
    expect(gmail("search_email_verbose")).toBe("refuse");
    expect(
      decide(
        "Google_Calendar_Tool",
        { action: "search_event" },
        { origin: connector }
      )
    ).toBe("refuse");
    // Given, but not a read: still refused.
    expect(
      gmail("send_email", {
        ...POLICY,
        connectorReads: { Gmail_Tool: ["send_email"] },
      })
    ).toBe("refuse");
    // None by default.
    expect(gmail("search_email", { sources: [], watchUrl: null })).toBe(
      "refuse"
    );
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

  it("fetches exactly the declared pages, hosts matched exactly", () => {
    expect(decide("web_fetch", { url: "https://news.example/" })).toBe("allow");
    expect(decide("web_fetch", { url: "https://NEWS.example./" })).toBe(
      "allow"
    );
    for (const url of [
      "https://news.example/today",
      "https://news.example/?x=1",
      "http://news.example/",
      "https://news.example:8443/",
      "http://attacker.example/?d=secret",
      "https://attacker.news.example/",
      "https://news.example.attacker.example/",
      "https://169.254.169.254/latest/meta-data/",
      "not a url",
    ])
      expect(decide("web_fetch", { url }), url).toBe("refuse");
  });

  it("is held from the first call: no query, no path beyond a declared one", () => {
    const policy = { ...POLICY, sources: ["https://blog.example/posts/"] };
    // Held whether or not the caller says so: the prompt can carry private data.
    for (const held of [false, true]) {
      for (const url of [
        "https://blog.example/posts/1?q=a",
        "https://blog.example/posts/?d=inbox",
        "https://blog.example/posts/bank-statement",
      ])
        expect(decide("web_fetch", { url }, { policy, held }), url).toBe(
          "refuse"
        );
      expect(
        decide(
          "web_fetch",
          { url: "https://blog.example/posts/" },
          { policy, held }
        )
      ).toBe("allow");
    }
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
          policy: { sources: [], watchUrl: null },
        }
      )
    ).toBe("refuse");
  });
});

describe("reads, the way the file tools read paths", () => {
  it.each([
    ["read", { path: "~/.ssh/id_rsa" }],
    ["read", { path: "~" }],
    ["read", { path: "file:///etc/passwd" }],
    ["read", { path: "@/etc/passwd" }],
    ["read", { path: "file://not a url" }],
    ["batch_file_read", { paths: ["notes.md", "~/.aws/credentials"] }],
    ["grep", { pattern: "x", path: "@/etc" }],
    ["ls", { path: "~/" }],
    ["find", { pattern: "*", path: "file:///" }],
  ])("refuses %s %j, which lands outside the folder", (name, input) => {
    expect(decide(name, input)).toBe("refuse");
  });

  it("still reads the folder's own files, an @-prefixed one included", () => {
    expect(decide("read", { path: "@notes.md" })).toBe("allow");
    expect(decide("read", { path: `file://${WORKSPACE}/notes.md` })).toBe(
      "allow"
    );
  });

  it("is not widened by anything the session allowed", () => {
    expect(
      decide("read", { path: "/etc/hosts" }, { allowedReadPaths: ["/etc"] })
    ).toBe("refuse");
  });

  it("asks in the attended modes too, for the same spellings", () => {
    for (const path of ["~/.ssh/id_rsa", "file:///etc/passwd", "@/etc/passwd"])
      for (const mode of [AgentMode.Normal, AgentMode.AcceptEdits])
        expect(
          gateToolCall(call("read", { path }), {
            ...options(),
            mode,
          }).kind,
          `${mode} ${path}`
        ).toBe("ask");
    expect(
      gateToolCall(call("write", { path: "~/.bashrc", content: "x" }), {
        ...options(),
        mode: AgentMode.AcceptEdits,
      }).kind
    ).toBe("ask");
  });
});

describe("cronjob in the attended modes", () => {
  const attended = (input: Record<string, unknown>) =>
    gateToolCall(call("cronjob", input), {
      ...options(),
      mode: AgentMode.Normal,
    }).kind;

  it("asks before a routine that runs on the server or reads the web", () => {
    expect(attended({ action: "create", runner: "hosted", prompt: "x" })).toBe(
      "ask"
    );
    expect(
      attended({ action: "update", id: "r", source_hosts: ["a.example"] })
    ).toBe("ask");
    expect(
      attended({ action: "create", watch_url: "https://a.example/" })
    ).toBe("ask");
    expect(
      attended({ action: "create", sources: ["https://a.example/"] })
    ).toBe("ask");
    expect(attended({ action: "create", reads: ["gmail"] })).toBe("ask");
  });

  it("leaves a local routine and a list as they were", () => {
    expect(
      attended({ action: "create", prompt: "x", schedule: "0 9 * * *" })
    ).toBe("allow");
    expect(attended({ action: "list" })).toBe("allow");
  });
});

describe("declared sources", () => {
  it("are URL prefixes, a bare host being its https root", () => {
    expect(sourceAllows("https://a.example/x", ["a.example"], false)).toBe(
      true
    );
    expect(
      sourceAllows(
        "https://a.example/blog/2",
        ["https://a.example/blog"],
        false
      )
    ).toBe(true);
    expect(
      sourceAllows(
        "https://a.example/blogger",
        ["https://a.example/blog"],
        false
      )
    ).toBe(false);
    expect(
      sourceAllows("https://u:p@a.example/", ["https://a.example/"], false)
    ).toBe(false);
  });

  it("are never a host anyone can publish on", () => {
    for (const host of [
      "docs.google.com",
      "script.google.com",
      "webhook.site",
      "pastebin.com",
      "me.github.io",
      "x.workers.dev",
    ])
      expect(isMultiTenantHost(host), host).toBe(true);
    expect(isMultiTenantHost("news.example")).toBe(false);
    expect(
      sourceAllows(
        "https://docs.google.com/forms/d/x",
        ["https://docs.google.com/forms/"],
        false
      )
    ).toBe(false);
    expect(
      parseUnattendedPolicy({
        sources: ["https://webhook.site/abc", "news.example"],
        watchUrl: null,
      })?.sources
    ).toEqual(["https://news.example/"]);
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

  it("parses the policy, and nothing else", () => {
    expect(
      parseUnattendedPolicy(
        JSON.stringify({
          sources: ["A.example", 3, "ftp://x.example/"],
          watchUrl: "",
          connectorReads: {
            Gmail_Tool: ["search_email", "send_email"],
            Slack_Tool: ["search"],
          },
          privateInput: true,
        })
      )
    ).toEqual({
      sources: ["https://a.example/"],
      watchUrl: null,
      connectorReads: { Gmail_Tool: ["search_email"] },
      privateInput: true,
    });
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

  it("holds web_fetch from the start, from the mode and policy alone", () => {
    setCurrentMode(AgentMode.Unattended);
    setUnattendedPolicy(POLICY);
    // No private read yet, as after a respawn: held all the same.
    expect(fetchHold()).toEqual({
      sources: ["https://news.example/"],
      held: true,
    });
    // Kept for callers; changes nothing.
    markPrivateRead();
    expect(fetchHold()?.held).toBe(true);
    setUnattendedPolicy({ ...POLICY, privateInput: true });
    expect(fetchHold()?.held).toBe(true);
    // A policy alone holds, whatever the mode says.
    setCurrentMode(AgentMode.Yolo);
    expect(fetchHold()?.held).toBe(true);
    setUnattendedPolicy(null);
    expect(fetchHold()).toBeNull();
    setCurrentMode(AgentMode.Unattended);
    expect(fetchHold()).toEqual({ sources: [], held: true });
    setCurrentMode(AgentMode.Yolo);
    expect(fetchHold()).toBeNull();
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
    expect(fetchHold()?.sources).toEqual(["https://news.example/"]);

    const normal = new AbacusBotSession({
      cwd: "/tmp",
      mode: "DEFAULT",
      emit: emit as never,
    });
    normal.setMode("UNATTENDED");
    expect((normal as unknown as { mode: AgentMode }).mode).toBe(
      AgentMode.Normal
    );
    expect(fetchHold()).toBeNull();
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
        hold: { sources: ["https://news.example/"], held: false },
      })
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  it("refuses a declared host that resolves somewhere private", async () => {
    const { fetchUrl } = await import("./web/fetch.js");
    await expect(
      fetchUrl("http://127.0.0.1:9/", {
        hold: { sources: ["http://127.0.0.1:9/"], held: false },
      })
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
    await expect(
      fetchUrl("http://10.0.0.1/", {
        hold: { sources: ["http://10.0.0.1/"], held: false },
      })
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
      fetchUrl("https://news.example/r", {
        hold: { sources: ["https://news.example/"], held: false },
      })
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
    expect(fetched).toEqual(["https://news.example/r"]);
    expect(lookup.mock.calls.map((args) => args[0])).toEqual(["news.example"]);
  });
});

describe("addresses a held fetch never dials", () => {
  it.each([
    "10.1.2.3",
    "100.64.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.0.8",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "240.0.0.1",
    "::",
    "::1",
    "ff02::1",
    "fe80::1",
    "fd00:ec2::254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.0.0.1",
    "64:ff9b:1::1",
    "2002:a9fe:a9fe::1",
    "2001::1",
    "2001:db8::1",
    "100::1",
    "::10.0.0.1",
    "::ffff:127.0.0.1",
  ])("refuses %s", async (address) => {
    const { isNonPublicAddress } = await import("./web/fetch.js");
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "8.8.8.8"])(
    "allows the public %s",
    async (address) => {
      const { isNonPublicAddress } = await import("./web/fetch.js");
      expect(isNonPublicAddress(address)).toBe(false);
    }
  );
});

describe("names and hosts that try to pass for something else", () => {
  it("never reads a tool rule off Object's prototype", () => {
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ])
      expect(decide(name), name).toBe("refuse");
    expect(
      decide(
        "abacus-connectors_constructor",
        { action: "call" },
        { origin: () => "connector" }
      )
    ).toBe("refuse");
  });

  it("compares an internationalized host in its ASCII form", () => {
    expect(
      sourceAllows(
        "https://xn--bcher-kva.example/a",
        ["https://bücher.example/"],
        false
      )
    ).toBe(true);
    expect(
      sourceAllows(
        "https://bücher.example/a",
        ["https://xn--bcher-kva.example/"],
        false
      )
    ).toBe(true);
    expect(
      sourceAllows(
        "https://bucher.example/a",
        ["https://bücher.example/"],
        false
      )
    ).toBe(false);
  });
});

describe("a chat that reads no files", () => {
  const noFiles: UnattendedPolicy = {
    sources: [],
    watchUrl: null,
    files: false,
  };

  it("refuses every workspace read, with a short reason", () => {
    for (const [name, rule] of Object.entries(UNATTENDED_TOOLS)) {
      if (rule !== "workspace-read") continue;
      const gate = gateToolCall(
        call(name, { path: "notes.md", paths: ["notes.md"] }),
        options({ policy: noFiles })
      );
      expect(gate, name).toEqual({
        kind: "refuse",
        reason: "This chat cannot read files.",
      });
    }
    // The rest of the allowlist is untouched.
    expect(decide("current_time", {}, { policy: noFiles })).toBe("allow");
  });

  it("comes over the wire, and absent means the folder's files", () => {
    expect(
      parseUnattendedPolicy('{"sources":[],"watchUrl":null,"files":false}')
        ?.files
    ).toBe(false);
    expect(parseUnattendedPolicy({ sources: [] })).not.toHaveProperty("files");
    expect(decide("read", { path: "notes.md" })).toBe("allow");
  });
});

describe("secrets inside the folder", () => {
  it.each([
    ["read", { path: ".env" }],
    ["read", { path: "config/.env.production" }],
    ["read", { path: "certs/server.pem" }],
    ["read", { path: "deploy/id_ed25519" }],
    ["read", { path: ".ssh/config" }],
    ["read", { path: ".npmrc" }],
    ["read", { path: "credentials.json" }],
    ["grep", { pattern: "KEY", path: ".env" }],
    ["batch_file_read", { paths: ["notes.md", "keys/app.key"] }],
    ["read", { path: "~/.aws/credentials" }],
  ])("refuses %s %j", (name, input) => {
    expect(decide(name, input)).toBe("refuse");
  });

  it("still reads ordinary files and templates", () => {
    for (const file of ["notes.md", ".env.example", "src/environment.ts"])
      expect(decide("read", { path: file }), file).toBe("allow");
  });

  it("follows a link to what it really reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unattended-secret-"));
    try {
      fs.writeFileSync(path.join(root, ".env"), "TOKEN=x");
      fs.symlinkSync(path.join(root, ".env"), path.join(root, "notes.txt"));
      expect(
        gateToolCall(call("read", { path: "notes.txt" }), {
          ...options(),
          cwd: root,
        }).kind
      ).toBe("refuse");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is not judged by the folder's own name", () => {
    expect(
      gateToolCall(call("read", { path: "notes.md" }), {
        ...options(),
        cwd: "/tmp/secrets",
      }).kind
    ).toBe("allow");
  });
});

describe("Windows spellings of one path", () => {
  it.each([
    "C:\\work\\x.txt",
    "C:/work/x.txt",
    "c:\\work\\x.txt",
    "/c/work/x.txt",
    "/mnt/c/work/x.txt",
    "/cygdrive/c/work/x.txt",
    "\\\\?\\C:\\work\\x.txt",
    "//?/C:/work/x.txt",
    "\\\\.\\C:\\work\\x.txt",
    "x.txt",
    "file:///C:/work/x.txt",
  ])("%s lands on C:\\work\\x.txt", (raw) => {
    expect(toolPath(raw, "C:\\work", "win32")?.toLowerCase()).toBe(
      "c:\\work\\x.txt"
    );
  });

  it("keeps a long UNC path a share, and a device path outside", () => {
    expect(toolPath("\\\\?\\UNC\\host\\share\\x", "C:\\work", "win32")).toBe(
      "\\\\host\\share\\x"
    );
    expect(toolPath("\\\\.\\PhysicalDrive0", "C:\\work", "win32")).not.toMatch(
      /^C:\\work/i
    );
    // Elsewhere a path that looks like a drive is just a path.
    expect(toolPath("/c/x", "/work", "linux")).toBe("/c/x");
  });
});

describe("code_map in an unattended run", () => {
  it("does not follow a link out of the folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unattended-map-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "unattended-out-"));
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;");
      fs.mkdirSync(path.join(root, "lib"));
      fs.writeFileSync(path.join(root, "lib", "c.ts"), "export const c = 1;");
      fs.writeFileSync(path.join(outside, "b.ts"), "export const b = 1;");
      fs.symlinkSync(outside, path.join(root, "linked"));
      fs.symlinkSync(path.join(outside, "b.ts"), path.join(root, "b.ts"));
      fs.symlinkSync(path.join(root, "lib"), path.join(root, "inner"));
      const scan = (within?: string) =>
        collectFiles(root, (file) => file.endsWith(".ts"), {
          maxFiles: 100,
          maxDepth: 5,
          timeBudgetMs: 5_000,
          ...(within != null ? { within } : {}),
        }).files.map((file) => path.relative(root, file));
      expect(scan()).toEqual(
        expect.arrayContaining(["b.ts", path.join("linked", "b.ts")])
      );
      const held = scan(root);
      expect(held).toContain(path.join("src", "a.ts"));
      expect(held).not.toContain("b.ts");
      expect(held).not.toContain(path.join("linked", "b.ts"));
      // A link that stays inside is still followed.
      expect(held.some((file) => file.endsWith("c.ts"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
