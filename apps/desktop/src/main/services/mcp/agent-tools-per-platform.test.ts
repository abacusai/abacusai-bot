/**
 * One tool per platform, nothing shared.
 *
 * The rule after a Discord DM vanished behind a WhatsApp address
 * book: a platform's contacts, messages and senders never appear beside
 * another platform's. Each platform has its own send, read, list and
 * auto-reply tool; the cross-platform originals are hidden from the model.
 */
import { describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

type Sent = { platform: string; chatId: string; text: string };

const harness = (running: string[]) => {
  const sent: Sent[] = [];
  const reads: Array<Record<string, unknown>> = [];
  const allowed: Array<{ platform: string; name: string }> = [];
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    botIdForSession: () => "bot-1",
    messaging: {
      runningPlatforms: () => running,
      livePlatforms: () => running,
      listChats: () => [],
      send: async (platform: string, chatId: string, text: string) => {
        sent.push({ platform, chatId, text });
      },
      readMessages: async (filter: Record<string, unknown>) => {
        reads.push(filter);
        return [];
      },
      autoReply: {
        status: () => ({
          enabled: false,
          botId: null,
          approved: [],
          pending: [],
        }),
        enable: () => {},
        disable: () => {},
        senderCandidates: (platform: string) => [
          { platform, userId: "u1", chatId: "u1", name: "Anuja" },
        ],
        allowSender: (candidate: { platform: string; name: string }) => {
          allowed.push({ platform: candidate.platform, name: candidate.name });
        },
        removeSender: () => {},
      },
    },
  } as never);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await (
      server as unknown as {
        executeTool: (
          n: string,
          a: Record<string, unknown>,
          s?: string
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool(name, args, "bot-session");
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  return { server, sent, reads, allowed, call };
};

describe("the model's messaging tools", () => {
  it("are per platform; the cross-platform originals are not listed", () => {
    const { server } = harness(["whatsapp", "discord"]);
    const listed = server.listedToolNames(true);

    for (const shared of [
      "send_chat_message",
      "read_chat_messages",
      "list_chats",
      "auto_reply",
    ])
      expect(listed).not.toContain(shared);

    for (const own of [
      "list_whatsapp_chats",
      "send_whatsapp_message",
      "read_whatsapp_messages",
      "whatsapp_auto_reply",
      "list_discord_chats",
      "send_discord_message",
      "read_discord_messages",
      "discord_auto_reply",
    ])
      expect(listed).toContain(own);
  });

  it("exist only for platforms that are running", () => {
    const { server } = harness(["whatsapp"]);
    const listed = server.listedToolNames(true);
    expect(listed).toContain("send_whatsapp_message");
    expect(listed).not.toContain("send_discord_message");
    expect(listed).not.toContain("list_telegram_chats");
  });

  it("send goes to its own platform, whatever the args say", async () => {
    const { sent, call } = harness(["whatsapp", "discord"]);
    await call("send_discord_message", { to: "123/456", message: "hi" });
    expect(sent).toEqual([
      { platform: "discord", chatId: "123/456", text: "hi" },
    ]);
  });

  it("read is scoped to its own platform", async () => {
    const { reads, call } = harness(["whatsapp", "discord"]);
    await call("read_whatsapp_messages", { chat_id: "Ma", limit: 5 });
    expect(reads).toEqual([{ platform: "whatsapp", chatId: "Ma", limit: 5 }]);
  });

  it("auto-reply allows the sender on its own platform, no platform question", async () => {
    const { allowed, call } = harness(["whatsapp", "discord"]);
    const text = await call("discord_auto_reply", {
      action: "allow_sender",
      sender: "Anuja",
    });
    expect(allowed).toEqual([{ platform: "discord", name: "Anuja" }]);
    expect(text).not.toMatch(/say which one/);
  });
});
