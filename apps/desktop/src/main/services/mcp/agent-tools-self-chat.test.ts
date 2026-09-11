/**
 * What `list_chats` says about who the user is on each platform.
 *
 * The "me" row is the agent's only way to know: it is not in any address book,
 * and the connector has to work it out from WhatsApp's own UI. When that
 * lookup missed, the row simply vanished from the answer — and the model
 * filled the gap by asking the user for the number of the phone they had just
 * paired, which is the one thing it should never have to ask.
 */
import { describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

const serverWith = (messaging: Record<string, unknown>): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    messaging: {
      listChats: () => [],
      send: async () => undefined,
      readMessages: async () => [],
      ...messaging,
    },
  } as never);

const listChats = async (
  messaging: Record<string, unknown>
): Promise<string> => {
  const result = await (
    serverWith(messaging) as unknown as {
      listChats: (args: Record<string, unknown>) => Promise<{
        content: { text?: string }[];
      }>;
    }
  ).listChats({});

  return result.content.map((part) => part.text ?? "").join("\n");
};

const linked = {
  runningPlatforms: () => ["whatsapp"],
  livePlatforms: () => ["whatsapp"],
};

describe("who the user is on a platform", () => {
  it("names their own chat when the connector worked it out", async () => {
    const text = await listChats({
      ...linked,
      selfChats: () => [{ platform: "whatsapp", chatId: "Alex (You)" }],
    });

    expect(text).toContain("Alex (You)");
    expect(text).toMatch(/the user — "me"/);
  });

  it("says it does not know, rather than leaving the row out in silence", async () => {
    // The silence is the bug: nothing in the answer said "me" was missing, so
    // nothing told the model to stop and say so instead of asking.
    const text = await listChats({ ...linked, selfChats: () => [] });

    expect(text).toMatch(/who the user is on whatsapp is not known/i);
  });

  it("tells the model not to ask the user for their own number", async () => {
    const text = await listChats({ ...linked, selfChats: () => [] });

    expect(text).toMatch(/do not ask them for their own number/i);
  });

  it("says nothing extra once every live platform knows its own chat", async () => {
    const text = await listChats({
      ...linked,
      selfChats: () => [{ platform: "whatsapp", chatId: "Alex (You)" }],
    });

    expect(text).not.toMatch(/is not known yet/i);
  });

  it("only counts platforms that are actually linked", async () => {
    // A platform that is down is already reported as down; adding "and it does
    // not know who you are" says the same thing twice and reads as a second,
    // separate problem.
    const text = await listChats({
      runningPlatforms: () => ["whatsapp", "telegram"],
      livePlatforms: () => ["telegram"],
      selfChats: () => [{ platform: "telegram", chatId: "me" }],
    });

    expect(text).not.toMatch(/is not known yet/i);
  });
});
