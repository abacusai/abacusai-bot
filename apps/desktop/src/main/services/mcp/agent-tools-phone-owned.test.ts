/**
 * The WhatsApp chat reads only its own tool words. Every agent-tools tool on
 * the phone's roster has a phone definition (tools/phone) over the engine the
 * app's tool runs, or is on the not-yet list, which only shrinks; nothing
 * else reaches it, listed or called. The app's listing is untouched.
 */
import fs from "fs";
import path from "path";

import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import {
  PHONE_AGENT_TOOL_NAMES,
  PHONE_MCP_TOOLS,
} from "@abacus-ai/agent/tool-policy";
import type { ConnectorStatuses } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";
import type { McpToolListing } from "./mcp-http-server";
import { AGENT_TOOL_NAMES } from "./tools";
import { NOT_YET_PHONE_OWNED, PHONE_AGENT_TOOLS } from "./tools/phone";

const PHONE = "phone-session";

/**
 * Product nouns a WhatsApp user can do nothing with, read over the phone
 * files' source. English only: these files are written in English.
 */
const APP_ONLY =
  /\bpanes?\b|\bCapabilities\b|\bConnect (card|button)\b|\b(Routines|Plugins|Connectors) (panel|page)\b|\bfiles card\b|\bsidebar\b|\bin the app\b|localhost|127\.0\.0\.1|file:\/\/|(?<![\w/.:])(\/home\/|\/tmp\/|\/Users\/)/i;

/**
 * FROZEN: the largest the not-yet list may be. Shrink this copy with the list
 * when a phone definition lands; never grow either.
 */
const NOT_YET_MAX_LENGTH = 10;
const NOT_YET_AT_MOST = [
  "skills_list",
  "skill_view",
  "cronjob",
  "vision_analyze",
  "video_analyze",
  "x_search",
  "pdf",
  "deck_export_pdf",
  "serve",
  "present_deliverable",
];

let statuses: ConnectorStatuses;
const link = vi.fn(async (connectorId: string) =>
  connectorId === "abacus-slack"
    ? {
        url: "https://apps.example/connect?service=slack&r=req",
        connectorIds: [connectorId],
      }
    : null
);
const show = vi.fn();
const watch = vi.fn();
const disablePlatform = vi.fn(async () => {});
const disconnect = vi.fn(async () => null);

const server = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () =>
      new Set(["connectors", "todo", "cronjob", "pdf", "memory"]),
    workspacePath: () => null,
    channelForSession: (session: string) =>
      session === PHONE ? WHATSAPP_CHANNEL : null,
    conversationKeyForSession: (session: string) =>
      sessionConversationKey("ws-1", session),
    connectors: { list: async () => statuses, link, show, watch, disconnect },
    messaging: {
      runningPlatforms: () => ["whatsapp"] as never,
      livePlatforms: () => ["whatsapp"] as never,
      disablePlatform,
      listChats: () => [],
      send: async () => undefined as never,
      readMessages: async () => [] as never,
    } as never,
  } as never);

const listTools = (session?: string): McpToolListing[] =>
  (
    server() as unknown as { listTools: (s?: string) => McpToolListing[] }
  ).listTools(session);

const call = async (
  name: string,
  args: Record<string, unknown>,
  session = PHONE
): Promise<{ text: string; isError: boolean }> => {
  const result = (await server().executeTool(name, args, session)) as {
    content: Array<{ text?: string }>;
    isError?: boolean;
  };
  return {
    text: result.content.map((part) => part.text ?? "").join("\n"),
    isError: result.isError === true,
  };
};

beforeEach(() => {
  statuses = {};
  vi.clearAllMocks();
});

describe("the phone's tool words", () => {
  it("come from a phone definition for every tool on its roster, or the shrinking not-yet list", () => {
    const owned = new Set(PHONE_AGENT_TOOLS.map((tool) => tool.name));
    expect(NOT_YET_AT_MOST).toHaveLength(NOT_YET_MAX_LENGTH);
    expect(NOT_YET_PHONE_OWNED.length).toBeLessThanOrEqual(NOT_YET_MAX_LENGTH);
    expect(new Set(NOT_YET_PHONE_OWNED).size).toBe(NOT_YET_PHONE_OWNED.length);
    for (const name of NOT_YET_PHONE_OWNED) {
      expect(NOT_YET_AT_MOST, `${name}: write its phone definition`).toContain(
        name
      );
      expect(owned.has(name), `${name} is phone-owned already`).toBe(false);
    }
    for (const definition of PHONE_AGENT_TOOLS)
      expect(definition.surface).toBe("phone");
    expect(new Set([...owned, ...NOT_YET_PHONE_OWNED])).toEqual(
      new Set(PHONE_AGENT_TOOL_NAMES)
    );
    for (const name of PHONE_MCP_TOOLS.builtin.filter((tool) =>
      AGENT_TOOL_NAMES.includes(tool)
    ))
      expect(
        owned.has(name) || NOT_YET_PHONE_OWNED.includes(name),
        `${name}: on the phone's roster with no phone definition`
      ).toBe(true);
  });

  it("lists the phone nothing else, and refuses a call to anything else", async () => {
    const listed = listTools(PHONE).map((tool) => tool.name);
    const allowed = new Set([
      ...PHONE_AGENT_TOOLS.map((tool) => tool.name),
      ...NOT_YET_PHONE_OWNED,
    ]);
    for (const name of listed) expect(allowed.has(name), name).toBe(true);
    expect(listed).toEqual(
      expect.arrayContaining(["connect_connector", "disconnect_connector"])
    );
    expect(listed).not.toContain("todo");
    expect(await call("todo", { action: "list" })).toEqual({
      text: "Unknown tool: todo",
      isError: true,
    });
  });

  it("serves the phone's own connector words, and the app keeps its own", () => {
    const phone = listTools(PHONE).find(
      (tool) => tool.name === "connect_connector"
    );
    const app = listTools("ui-session").find(
      (tool) => tool.name === "connect_connector"
    );
    expect(phone?.description).not.toMatch(APP_ONLY);
    expect(JSON.stringify(phone?.inputSchema)).not.toMatch(APP_ONLY);
    expect(app?.description).toContain("Connect card up in the app");
  });

  it("never names an app-only thing in a phone file", () => {
    const dir = path.join(__dirname, "tools", "phone");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(
        fs.readFileSync(path.join(dir, file), "utf8").replace(APP_ONLY, ""),
        file
      ).toBe(fs.readFileSync(path.join(dir, file), "utf8"));
  });
});

describe("connect_connector on the phone", () => {
  it("sends a link for an account connector, with no card", async () => {
    const { text } = await call("connect_connector", { service: "slack" });
    expect(text).toContain("https://apps.example/connect?service=slack&r=req");
    expect(show).not.toHaveBeenCalled();
    expect(text).not.toMatch(APP_ONLY);
  });

  it("says plainly what cannot be connected from WhatsApp, and claims no card", async () => {
    const { text } = await call("connect_connector", { service: "telegram" });
    expect(text).toBe(
      "Telegram cannot be connected or used from WhatsApp. Say so plainly in one short line, and do whatever part of the task does not need it."
    );
    expect(show).not.toHaveBeenCalled();
  });

  it("never offers a connected chat app's tools: the phone cannot use them", async () => {
    statuses = { "messaging-telegram": { state: "connected" } } as never;
    const { text } = await call("connect_connector", { service: "telegram" });
    expect(text).toMatch(
      /^Telegram cannot be connected or used from WhatsApp\./
    );
    expect(text).not.toMatch(/send_<platform>_message|tool list/);
  });

  it("lists only what the user can connect from the chat", async () => {
    const { text } = await call("connect_connector", {});
    expect(text).toContain("Slack");
    expect(text).not.toMatch(/telegram|discord/i);
    expect(text).not.toMatch(APP_ONLY);
  });
});

describe("a hosted computer that requires a session", () => {
  const strict = (): McpAgentToolsServer =>
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["connectors", "todo"]),
      workspacePath: () => null,
      requireSession: () => true,
      knownSession: (session: string) => session === "live",
    } as never);

  it("lists nothing and runs nothing for a call with no session or an unknown one", async () => {
    for (const session of [undefined, "stranger"]) {
      expect(
        (
          strict() as unknown as {
            listTools: (s?: string) => McpToolListing[];
          }
        ).listTools(session)
      ).toEqual([]);
      const result = (await strict().executeTool(
        "todo",
        { action: "list" },
        session
      )) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe(
        "This call names no session here, so no tool runs."
      );
    }
    expect(
      (
        strict() as unknown as { listTools: (s?: string) => McpToolListing[] }
      ).listTools("live").length
    ).toBeGreaterThan(0);
  });
});

describe("disconnect_connector on the phone", () => {
  it("never switches a chat app off, and says nothing changed", async () => {
    const { text } = await call("disconnect_connector", {
      service: "whatsapp",
    });
    expect(text).toBe(
      "WhatsApp cannot be disconnected from WhatsApp, and nothing was changed. Say so plainly."
    );
    expect(disablePlatform).not.toHaveBeenCalled();
  });

  it("disconnects an account connector, and says so only once it is done", async () => {
    statuses = { "abacus-slack": { state: "connected" } } as never;
    const { text } = await call("disconnect_connector", { service: "slack" });
    expect(disconnect).toHaveBeenCalledWith("abacus-slack");
    expect(text).toMatch(/^Slack is disconnected\./);
  });
});
