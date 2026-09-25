/**
 * "Which groups have new messages?": asked of the WhatsApp bot, and answered
 * with "I have no tool for that", which was true. The list and read tools
 * now take `only_unread`, answered live from the platform's own counters;
 * what the model sees when the platform can, cannot, or has nothing waiting.
 */
import { describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

type Unread = { chatId: string; name: string; unreadCount: number };

const harness = (
  unread: (() => Promise<Unread[] | null>) | undefined,
  options: { live?: boolean } = {}
) => {
  const reads: Array<Record<string, unknown>> = [];
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    messaging: {
      runningPlatforms: () => ["whatsapp"],
      livePlatforms: () => (options.live === false ? [] : ["whatsapp"]),
      awaitReady: async () => {},
      listChats: () => [],
      listChatsDetailed: () => ({ rows: [], hidden: {} }),
      send: async () => {},
      readMessages: async (filter: Record<string, unknown>) => {
        reads.push(filter);
        return [
          {
            platform: "whatsapp",
            chatId: filter.chatId,
            userId: "Raj",
            userName: "Raj",
            text: `hello from ${String(filter.chatId)}`,
            direction: "in",
            at: "2026-09-03T08:00:00.000Z",
          },
        ];
      },
      ...(unread != null ? { unreadChats: unread } : {}),
    },
  } as never);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await (
      server as unknown as {
        executeTool: (
          n: string,
          a: Record<string, unknown>
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool(name, args);
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  return { call, reads };
};

const waiting: Unread[] = [
  { chatId: "School friendsss", name: "School friendsss", unreadCount: 3 },
  { chatId: "Raj", name: "Raj", unreadCount: 1 },
  { chatId: "Anuja", name: "Anuja", unreadCount: -1 },
];

describe("list_whatsapp_chats with only_unread", () => {
  it("lists the chats with messages waiting, with each count", async () => {
    const h = harness(async () => waiting);
    const text = await h.call("list_whatsapp_chats", { only_unread: true });
    expect(text).toContain("chats with unread messages (3)");
    expect(text).toContain('to: "School friendsss"  (3 unread)');
    expect(text).toContain('to: "Raj"  (1 unread)');
    // A chat marked unread by hand has no number; say what it is.
    expect(text).toContain('to: "Anuja"  (marked unread)');
  });

  it("says the user is caught up when nothing is waiting", async () => {
    const h = harness(async () => []);
    const text = await h.call("list_whatsapp_chats", { only_unread: true });
    expect(text).toContain("No whatsapp chats have unread messages");
  });

  it("passes the platform's reason on when it cannot say right now", async () => {
    const h = harness(async () => {
      throw new Error("the store bridge is not attached to this session.");
    });
    const text = await h.call("list_whatsapp_chats", { only_unread: true });
    expect(text).toContain("the store bridge is not attached");
    expect(text).toContain("offer to read a chat they name");
  });

  it("says so when the platform cannot report unread at all", async () => {
    const withNull = harness(async () => null);
    expect(
      await withNull.call("list_whatsapp_chats", { only_unread: true })
    ).toContain("cannot report unread counts");
    const without = harness(undefined);
    expect(
      await without.call("list_whatsapp_chats", { only_unread: true })
    ).toContain("cannot report unread counts");
  });

  it("blames the connection, not the chats, while the platform is down", async () => {
    const h = harness(async () => waiting, { live: false });
    const text = await h.call("list_whatsapp_chats", { only_unread: true });
    expect(text).toContain("not connected right now");
  });
});

describe("read_whatsapp_messages with only_unread", () => {
  it("reads each waiting chat, up to its unread count, grouped by chat", async () => {
    const h = harness(async () => waiting);
    const text = await h.call("read_whatsapp_messages", { only_unread: true });
    expect(h.reads.map((r) => [r.chatId, r.limit])).toEqual([
      ["School friendsss", 3],
      ["Raj", 1],
      // Marked unread: no count to go by, so a short peek.
      ["Anuja", 5],
    ]);
    expect(text).toContain("- School friendsss (3 unread)");
    expect(text).toContain("Raj: hello from School friendsss");
    expect(text).toContain("- Anuja (marked unread)");
  });

  it("honours a smaller limit per chat", async () => {
    const h = harness(async () => waiting);
    await h.call("read_whatsapp_messages", { only_unread: true, limit: 2 });
    expect(h.reads.map((r) => r.limit)).toEqual([2, 1, 2]);
  });

  it("stops at ten chats and says how many more are waiting", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      chatId: `chat-${i}`,
      name: `chat-${i}`,
      unreadCount: 1,
    }));
    const h = harness(async () => many);
    const text = await h.call("read_whatsapp_messages", { only_unread: true });
    expect(h.reads).toHaveLength(10);
    expect(text).toContain("2 more chat(s) have unread messages");
  });

  it("is caught up when nothing is waiting", async () => {
    const h = harness(async () => []);
    const text = await h.call("read_whatsapp_messages", { only_unread: true });
    expect(text).toContain("No whatsapp chats have unread messages");
    expect(h.reads).toHaveLength(0);
  });
});
