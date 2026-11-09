/**
 * Every tool a caller's prompt tells it to call is in that caller's tool list.
 * The routine editor's prompt sent it to bot_help and billing_plan while it was
 * listed only cronjob; the model saw the tool missing and answered a flat no.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import type { Bot } from "@abacus-ai/contract/bots";
import { BOT_TEMPLATES } from "@abacus-ai/contract/bots/templates";
import { TOOLSETS_FOR_DISPLAY } from "@abacus-ai/contract/toolsets";
import { beforeAll, describe, expect, it } from "vitest";

import type { CronJob } from "../agent-tools/cron-store";
import {
  buildRoutineEditorPrompt,
  buildRoutineFirePrompt,
} from "../agent-tools/routine-prompt";
import { renderPersona, senderChatIntro } from "../bots/bot-service";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";
import { AGENT_TOOL_NAMES } from "./tools";
import { PHONE_AGENT_TOOLS } from "./tools/phone";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");

const agentSource = async <T>(file: string): Promise<T> =>
  (await import(
    pathToFileURL(path.join(REPO_ROOT, "packages/agent/src", file)).href
  )) as T;

/** Every tool the app serves, by name. */
const MCP_TOOLS = [
  ...new Set([
    ...AGENT_TOOL_NAMES,
    ...PHONE_AGENT_TOOLS.map((tool) => tool.name),
  ]),
];

/** Names a prompt can only mean as a tool; "memory" or "serve" read as words too. */
const TOOL_SHAPED = MCP_TOOLS.filter(
  (name) => name.includes("_") || name === "cronjob"
);

/**
 * The served tools a prompt orders. A line that names a tool only "while you
 * have" it is the prompt's own guard, so it orders nothing.
 */
const namedTools = (prompt: string): string[] => {
  const unguarded = prompt.replace(/while you have \w+/g, "");
  return TOOL_SHAPED.filter((name) =>
    new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(unguarded)
  );
};

const JOB: CronJob = {
  id: "job-1",
  name: "Morning brief",
  schedule: "0 8 * * 1-5",
  webhookToken: null,
  runAt: null,
  prompt: "Summarize what needs my attention.",
  workspaceId: null,
  botId: null,
  enabled: true,
  createdAt: 0,
  lastRunAt: null,
  lastResult: null,
  runs: [],
};

const agentTemplate = BOT_TEMPLATES.find((row) => row.id === "whatsapp-agent")!;
const BOT = {
  id: "bot-1",
  name: agentTemplate.name,
  title: agentTemplate.title,
  description: agentTemplate.mission,
  persona: agentTemplate.persona,
  avatarColor: agentTemplate.avatarColor,
  avatarShape: agentTemplate.avatarShape,
  workspaceId: null,
  sessionId: null,
  homeChannel: "whatsapp",
  templateId: agentTemplate.id,
  model: null,
} as unknown as Bot;

/** Sessions by kind; everything switched on, so a list is as full as it gets. */
const server = new McpAgentToolsServer({
  skillsService: {} as never,
  enabledToolsets: () => new Set(TOOLSETS_FOR_DISPLAY.map((set) => set.id)),
  workspacePath: () => null,
  workspaceId: () => null,
  botIdForSession: (session: string) =>
    session === "bot" || session === "sender" ? "bot-1" : null,
  routineEditorFor: (session: string) =>
    session === "editor" ? "job-1" : null,
  isUnattended: (session: string) =>
    session === "routine" || session === "sender",
  channelForSession: (session: string) =>
    session === "phone" ? WHATSAPP_CHANNEL : undefined,
  isAppBotChat: (session: string) => session === "bot",
  messaging: {
    runningPlatforms: () => ["whatsapp", "telegram", "discord"],
    listChats: () => [],
  },
  planTier: () => "basic",
} as never);

const listed = (session: string): string[] =>
  (
    server as unknown as {
      listTools: (callerSession?: string) => Array<{ name: string }>;
    }
  )
    .listTools(session)
    .map((tool) => tool.name);

let base = "";
let botRules = "";
let phoneRules = "";

beforeAll(async () => {
  base = (
    await agentSource<{ basePrompt: (edit: string) => string }>(
      "base-prompt.ts"
    )
  ).basePrompt("ours");
  botRules = (
    await agentSource<{ botOperatingPrompt: () => string }>(
      "bot/bot-prompts.ts"
    )
  ).botOperatingPrompt();
  phoneRules = (
    await agentSource<{ phoneOperatingPrompt: (model: null) => string }>(
      "phone/phone-prompts.ts"
    )
  ).phoneOperatingPrompt(null);
});

/**
 * Runs nobody is in (a routine, a contact's auto-reply line) are held to the
 * unattended allowlist: the base prompt's lines for what the user asks are not
 * theirs, so only their own prompt is checked.
 */
const CALLERS: Array<[string, string, () => string]> = [
  ["a main chat", "main", () => base],
  [
    "a bot's chat",
    "bot",
    () => [base, botRules, renderPersona(BOT, {})].join("\n"),
  ],
  ["the phone lane", "phone", () => [base, phoneRules].join("\n")],
  [
    "the routine editor",
    "editor",
    () =>
      [base, buildRoutineEditorPrompt(JOB, "make it hourly", null)].join("\n"),
  ],
  [
    "a routine's run",
    "routine",
    () => buildRoutineFirePrompt(JOB, "schedule", null),
  ],
  [
    "a contact's auto-reply line",
    "sender",
    () => senderChatIntro("Sam", "WhatsApp"),
  ],
];

describe("a caller's prompt names only tools it is listed", () => {
  it.each(CALLERS)("%s", (_kind, session, prompt) => {
    const missing = namedTools(prompt()).filter(
      (name) => !listed(session).includes(name)
    );
    expect(missing).toEqual([]);
  });

  it("finds what it checks for", () => {
    expect(namedTools(base)).toEqual(
      expect.arrayContaining(["bot_help", "billing_plan"])
    );
    expect(namedTools("call cronjob, while you have paid_feature")).toEqual([
      "cronjob",
    ]);
  });
});
