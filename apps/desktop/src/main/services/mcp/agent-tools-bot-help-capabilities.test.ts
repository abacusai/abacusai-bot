/**
 * bot_help says what the user can do, from the caller's own tools: the phone
 * route a chat-app agent's greeting promised, auto-reply only where it can be
 * switched on, and the routine editor answering instead of refusing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-help-capabilities-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const server = new McpAgentToolsServer({
  skillsService: {} as never,
  enabledToolsets: () => new Set(["messaging", "cronjob"]),
  workspacePath: () => null,
  workspaceId: () => null,
  botIdForSession: (session: string) => (session === "bot" ? "bot-1" : null),
  routineEditorFor: (session: string) =>
    session === "editor" ? "job-1" : null,
  messaging: {
    runningPlatforms: () => ["whatsapp"],
    listChats: () => [],
  },
  planTier: () => "basic",
} as never);

const ask = async (
  args: Record<string, unknown>,
  session: string,
  name = "bot_help"
): Promise<{ text: string; isError?: boolean }> => {
  const result = await (
    server as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
    }
  ).executeTool(name, args, session);
  return {
    text: result.content.map((part) => part.text ?? "").join("\n"),
    isError: result.isError,
  };
};

describe("bot_help on the chat apps", () => {
  it("gives the route from the phone, and never leaves an unlisted ask at no", async () => {
    const { text } = await ask({ topic: "chat_apps" }, "bot");
    expect(text).toContain('"Message yourself" chat');
    expect(text).toContain("WhatsApp Business");
    expect(text).toContain("never a flat no");
  });

  it("offers auto-reply where its tool is, and points elsewhere where it is not", async () => {
    const inBot = (await ask({ topic: "chat_apps" }, "bot")).text;
    const inMain = (await ask({ topic: "chat_apps" }, "main")).text;
    expect(inBot).toMatch(/answered automatically: Yes, now/);
    expect(inMain).toMatch(
      /answered automatically: Not from this chat: in a bot's own chat/
    );
  });
});

describe("a chat app's own chat", () => {
  it("is linked by its self lane, not the user's own account on that app", async () => {
    const lanes = (live: string[]) =>
      new McpAgentToolsServer({
        skillsService: {} as never,
        enabledToolsets: () => new Set(["messaging"]),
        workspacePath: () => null,
        workspaceId: () => null,
        messaging: {
          runningPlatforms: () => ["telegram", "abacus_telegram"],
          livePlatforms: () => live,
          listChats: () => [],
        },
      } as never);
    const answer = async (instance: McpAgentToolsServer) =>
      (
        await (
          instance as unknown as {
            executeTool: (
              name: string,
              args: Record<string, unknown>,
              session?: string
            ) => Promise<{ content: { text?: string }[] }>;
          }
        ).executeTool("bot_help", { topic: "chat_apps" }, "main")
      ).content
        .map((part) => part.text ?? "")
        .join("\n");
    expect(await answer(lanes(["abacus_telegram"]))).toContain(
      "Telegram: in Telegram they write to the Abacus AI bot"
    );
    // The user's own Telegram account linked, the shared bot's chat not.
    expect(await answer(lanes(["telegram"]))).toContain(
      "Telegram (after one step: link it under Messaging)"
    );
  });
});

describe("the routine editor", () => {
  it("answers what a routine can do from bot_help and billing_plan's facts, not a refusal", async () => {
    const { text, isError } = await ask({ topic: "routines" }, "editor");
    expect(isError).not.toBe(true);
    expect(text).toContain("Routines:");
    const other = await ask(
      { to: "me", text: "hi" },
      "editor",
      "send_whatsapp_message"
    );
    expect(other.text).toContain("can only change its routine");
  });
});
