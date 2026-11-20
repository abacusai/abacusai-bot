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

/**
 * Asked how to dictate or how to start a new chat, the model answered from
 * memory and named controls the app does not have: bot_help had nothing on
 * the app's own buttons. It now answers from the same entries the renderer's
 * tests hold to the message box, the rail and its pages.
 */
describe("bot_help on the app's own controls", () => {
  it.each([
    ["microphone", "mic"],
    ["microphone", "dictation"],
    ["microphone", "voice"],
  ])("finds the %s by %s, with how to stop it", async (_what, name) => {
    const { text } = await ask({ topic: "app", name }, "main");
    expect(text).toContain("- Dictate (also shown as Stop dictating):");
    expect(text).toContain("message box");
    expect(text).toContain("Escape cancels");
    // It is in the chat on screen: no page to send them to.
    expect(text).not.toContain("Where: ");
  });

  it("starts a new chat from Sessions, /new or the shortcut", async () => {
    const { text } = await ask({ topic: "app", name: "new chat" }, "main");
    expect(text).toContain("- New session:");
    expect(text).toContain("/new");
    expect(text).toContain("⌘N on a Mac, Ctrl+N on Windows and Linux");
    expect(text).toContain("Where: Sessions → New session.");
    expect(text).not.toContain("- Dictate");
  });

  it("is reached from the name alone, as the model words it", async () => {
    const { text } = await ask({ name: "dictate" }, "main");
    expect(text).toContain("- Dictate (also shown as Stop dictating):");
  });

  it("says it is not sure of a control the app has not got, never a guess", async () => {
    const { text } = await ask({ topic: "app", name: "hologram" }, "main");
    expect(text).toContain('Nothing in the app is called "hologram"');
    expect(text).toContain("never describe a button");
  });

  it("names every control in the overview, and their use only when asked", async () => {
    const overview = (await ask({}, "main")).text;
    expect(overview).toMatch(/New session, Dictate, Attach, Models/);
    expect(overview).toContain("call bot_help with topic app");
    expect(overview).not.toContain("Escape cancels");
    const all = (await ask({ topic: "app" }, "main")).text;
    expect(all).toContain("Escape cancels");
    expect(all).toMatch(/- Settings pages: General, Appearance/);
  });
});
