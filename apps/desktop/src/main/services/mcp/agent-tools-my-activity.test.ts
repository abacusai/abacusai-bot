/**
 * `my_activity`: a bot's own history, readable from any of its chats. A
 * channel session is minted fresh, and "what have you done so far" was
 * honestly answered "nothing" by a bot with a day of work in its main chat.
 * Channels are excluded unconditionally: what happens in a channel stays in
 * that channel, other channels included.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let home: string;
let logDir: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-my-activity-"));
  process.env.ABACUSAI_BOT_HOME = home;
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-my-activity-logs-"));
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
});

const writeLog = (name: string, turns: Array<[string, string]>): string => {
  const file = path.join(logDir, name);
  fs.writeFileSync(
    file,
    turns
      .map(([role, text]) =>
        JSON.stringify({ message: { role, content: [{ type: "text", text }] } })
      )
      .join("\n")
  );
  return file;
};

const call = async (
  chats: Array<{
    sessionId: string;
    label: string;
    role: "forever" | "sender" | "routine";
    file: string | null;
  }>,
  callerSession = "channel-session"
): Promise<string> => {
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set<string>(),
    workspacePath: () => null,
    botIdForSession: (sessionId: string) =>
      sessionId === "channel-session" ? "bot-1" : null,
    ownActivity: () => chats,
  } as never);
  const result = await (
    server as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("my_activity", {}, callerSession);

  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("my_activity", () => {
  it("reads the bot's other conversations", async () => {
    const forever = writeLog("forever.jsonl", [
      ["user", "connect my gmail"],
      ["assistant", "Connected Gmail, then pulled the latest 5 in the inbox."],
    ]);

    const text = await call([
      {
        sessionId: "forever-1",
        label: "gmail bot",
        role: "forever",
        file: forever,
      },
    ]);

    expect(text).toContain("Connected Gmail");
  });

  it("skips the calling conversation: its contents are already in context", async () => {
    const own = writeLog("own.jsonl", [["assistant", "own-line"]]);

    const text = await call(
      [
        {
          sessionId: "channel-session",
          label: "this chat",
          role: "sender",
          file: own,
        },
      ],
      "channel-session"
    );

    expect(text).not.toContain("own-line");
    expect(text).toContain("No other conversations");
  });

  it("refuses a plain session", async () => {
    // With the toolset off it is withheld like the rest of the bots tools;
    // either refusal keeps a non-bot caller out.
    const text = await call([], "session-1");
    expect(text).toMatch(/Only a bot's own chat|switched off in Capabilities/);
  });
});
