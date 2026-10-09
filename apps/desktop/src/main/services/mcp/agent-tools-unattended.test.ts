/**
 * A run nobody is watching (the unattended mode): every built-in tool the app
 * serves is classified, the servers hold such a session to its allowlist on
 * their own, and the browser opens only the routine's one page.
 */
import {
  UNATTENDED_BROWSER_TOOLS,
  UNATTENDED_EXCLUDED_TOOLS,
  UNATTENDED_TOOLS,
} from "@abacus-ai/agent/tool-policy";
import { AgentMode } from "@abacus-ai/contract/agent-types";
import { describe, expect, it, vi } from "vitest";

import { Vault } from "../vault/vault-tools";
import { BuiltinToolPermissions } from "./builtin-tool-permissions";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";
import { McpBrowserServer } from "./mcp-browser-server";
import { McpDeviceServer } from "./mcp-device-server";
import type { McpToolListing } from "./mcp-http-server";
import { AGENT_TOOL_NAMES } from "./tools";
import {
  heldBrowserRefusal,
  onWatchHost,
  watchHostIsPublic,
  watchPort,
} from "./unattended-browser";

vi.mock("#main/rpc/emit", () => ({ emitHostEvent: () => {} }));

const HELD = "routine-run";
const WATCH = "https://shop.example/flight/123";

const listed = (target: unknown, session?: string): string[] =>
  (target as { listTools: (s?: string) => McpToolListing[] })
    .listTools(session)
    .map((tool) => tool.name);

const agentTools = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () =>
      new Set(["todo", "memory", "cronjob", "skills", "pdf", "messaging"]),
    workspacePath: () => "/tmp",
    botIdForSession: () => null,
    isUnattended: (session: string) => session === HELD,
  } as never);

const text = (result: unknown): { text: string; isError: boolean } => {
  const r = result as { content: Array<{ text?: string }>; isError?: boolean };
  return {
    text: r.content.map((part) => part.text ?? "").join("\n"),
    isError: r.isError === true,
  };
};

describe("the unattended allowlist", () => {
  it("classifies every built-in tool the app serves: allowed or excluded, never neither", () => {
    const vault = new Vault({
      client: { maybeAvailable: () => true } as never,
      deliver: () => {},
    } as never);
    const builtins = [
      ...AGENT_TOOL_NAMES,
      ...listed(
        new McpBrowserServer({ target: () => null, vault: () => vault })
      ),
      ...listed(new McpDeviceServer()),
    ];
    expect(builtins).toEqual(
      expect.arrayContaining([
        "vault_items",
        "payment_approval",
        "browser_vault_fill",
        "browser_execute",
      ])
    );
    for (const name of builtins)
      expect(
        (UNATTENDED_TOOLS[name] != null) !==
          (UNATTENDED_EXCLUDED_TOOLS[name] != null),
        `${name}: name it in UNATTENDED_TOOLS or UNATTENDED_EXCLUDED_TOOLS`
      ).toBe(true);
  });

  it("serves the browser's read-only pair, and they are the browser's own", () => {
    const served = listed(new McpBrowserServer({ target: () => null }));
    for (const name of UNATTENDED_BROWSER_TOOLS) expect(served).toContain(name);
  });
});

describe("the agent-tools server, for a held session", () => {
  it("lists only what an unattended run may call", () => {
    const server = agentTools();
    const held = listed(server, HELD);
    expect(held.length).toBeGreaterThan(0);
    for (const name of held) expect(UNATTENDED_TOOLS[name], name).toBeDefined();
    expect(held).not.toContain("cronjob");
    expect(listed(server, "someone")).toContain("cronjob");
  });

  it.each(["cronjob", "memory", "send_whatsapp_message", "pdf", "serve"])(
    "refuses %s even when the agent asks",
    async (name) => {
      const result = text(await agentTools().executeTool(name, {}, HELD));
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/not available in a routine/);
    }
  );
});

describe("the browser, for a held session", () => {
  const held = { watchUrl: WATCH, isolated: true };

  it.each([
    "browser_interact",
    "browser_execute",
    "browser_tabs",
    "browser_vault_fill",
    "browser_traveler_fill",
    "browser_checkout",
    "browser_pause",
    "vault_items",
    "vault_request",
    "payment_approval",
    "signin_approval",
  ])("refuses %s", (name) => {
    expect(heldBrowserRefusal(name, {}, held)).toMatch(/not available/);
  });

  it("opens exactly the watch page, and reloads it", () => {
    expect(heldBrowserRefusal("browser_navigate", { url: WATCH }, held)).toBe(
      null
    );
    expect(
      heldBrowserRefusal("browser_navigate", { action: "reload" }, held)
    ).toBe(null);
    expect(heldBrowserRefusal("browser_snapshot", {}, held)).toBe(null);
    for (const url of [
      `${WATCH}?q=me@example.com`,
      "https://shop.example/flight/124",
      "https://attacker.example/",
    ])
      expect(
        heldBrowserRefusal("browser_navigate", { url }, held),
        url
      ).not.toBe(null);
    expect(
      heldBrowserRefusal("browser_navigate", { action: "back" }, held)
    ).not.toBe(null);
  });

  it("has no browser without an isolated context or a watch page", () => {
    expect(
      heldBrowserRefusal(
        "browser_navigate",
        { url: WATCH },
        { watchUrl: WATCH, isolated: false }
      )
    ).toMatch(/no browser/);
    expect(
      heldBrowserRefusal(
        "browser_snapshot",
        {},
        { watchUrl: null, isolated: true }
      )
    ).toMatch(/no browser/);
  });

  it("knows when the page left the watch page's host", () => {
    expect(onWatchHost(`${WATCH}#x`, WATCH)).toBe(true);
    expect(onWatchHost("https://SHOP.example/other", WATCH)).toBe(true);
    expect(onWatchHost("https://attacker.example/", WATCH)).toBe(false);
    expect(onWatchHost("https://shop.example.attacker.example/", WATCH)).toBe(
      false
    );
    expect(onWatchHost("http://shop.example/flight/123", WATCH)).toBe(false);
    expect(onWatchHost("about:blank", WATCH)).toBe(false);
  });

  it("refuses at the server, before any page or prompt", async () => {
    const requestPermission = vi.fn(async () => "allow" as const);
    const server = new McpBrowserServer({
      target: () => null,
      requestPermission,
      heldSession: (session) => (session === HELD ? held : null),
    });
    const run = async (name: string, args: Record<string, unknown>) =>
      text(
        await (
          server as unknown as {
            executeTool: (
              n: string,
              a: Record<string, unknown>,
              s?: string
            ) => Promise<unknown>;
          }
        ).executeTool(name, args, HELD)
      );
    expect((await run("browser_execute", { code: "1" })).isError).toBe(true);
    expect((await run("vault_items", {})).isError).toBe(true);
    expect(
      (await run("browser_navigate", { url: "https://attacker.example/" })).text
    ).toMatch(/exactly the page/);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("the built-in prompts, for a held session", () => {
  const permissions = (): BuiltinToolPermissions =>
    new BuiltinToolPermissions({
      mcpConfigService: {
        readState: () => ({ builtinBrowserApproval: "ask" }),
      } as never,
      emitEvent: () => {},
      getSessionMode: () => AgentMode.Unattended,
      isUnattended: (session) => session === HELD,
      setBrowserApprovalAlways: async () => {},
      conversationKeyForSession: () => null,
    });

  it("never asks: the browser holds the run itself, a device is never driven", async () => {
    expect(
      await permissions().request("browser", "browser_navigate", "", HELD)
    ).toBe("allow");
    expect(
      await permissions().request("device", "device_interact", "", HELD)
    ).toBe("deny");
  });
});

describe("the watch page's address", () => {
  it("is https only, on its own port", () => {
    expect(
      heldBrowserRefusal(
        "browser_navigate",
        { url: "http://shop.example/" },
        { watchUrl: "http://shop.example/", isolated: true }
      )
    ).toMatch(/https/);
    expect(onWatchHost("https://shop.example:8443/x", WATCH)).toBe(false);
  });

  it("names the one port its browser context may reach", () => {
    expect(watchPort(WATCH)).toBe(443);
    expect(watchPort("https://shop.example:8443/x")).toBe(8443);
    expect(watchPort(null)).toBeUndefined();
    expect(watchPort("not a url")).toBeUndefined();
  });

  it("is never one that resolves inside", async () => {
    const resolve = (address: string) => async () => [{ address }];
    expect(await watchHostIsPublic(WATCH, resolve("93.184.216.34"))).toBe(true);
    for (const address of [
      "169.254.169.254",
      "10.0.0.2",
      "::1",
      "64:ff9b::a9fe:a9fe",
    ])
      expect(await watchHostIsPublic(WATCH, resolve(address)), address).toBe(
        false
      );
    expect(await watchHostIsPublic("https://127.0.0.1/")).toBe(false);
    expect(
      await watchHostIsPublic(WATCH, async () => {
        throw new Error("no such host");
      })
    ).toBe(false);
  });
});
