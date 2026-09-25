/**
 * Sending to a platform that is not linked.
 *
 * The guard used to ask whether ANY platform was running, and "running" only
 * means a connector object exists: a phone that unlinks the device leaves one
 * in place, restarting for a fresh QR. So with Telegram up and WhatsApp not, a
 * WhatsApp send walked past the guard and came back reported as sent.
 */
import { describe, expect, it, vi } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

const send = vi.fn(async () => undefined);

const server = (messaging: Record<string, unknown>): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    messaging: {
      listChats: () => [],
      send,
      readMessages: async () => [],
      ...messaging,
    },
  } as never);

const call = async (
  messaging: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>
): Promise<string> => {
  const result = await (
    server(messaging) as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool(tool, args);

  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("sending to a platform that is not linked", () => {
  it("refuses, names the platform, and sends nothing", async () => {
    send.mockClear();

    const text = await call(
      {
        runningPlatforms: () => ["whatsapp", "telegram"],
        livePlatforms: () => ["telegram"],
      },
      "send_chat_message",
      { platform: "whatsapp", to: "chat-1", message: "hello" }
    );

    expect(text).toMatch(/whatsapp is not connected/i);
    expect(text).toMatch(/nothing was sent/i);
    // Named, not the generic hint: the agent has to tell "WhatsApp is down"
    // from "you have no platforms", or it asks the user to connect something
    // that is already connected.
    expect(text).not.toMatch(/No messaging platform is connected/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers on a platform that is actually linked", async () => {
    send.mockClear();

    const text = await call(
      {
        runningPlatforms: () => ["whatsapp", "telegram"],
        livePlatforms: () => ["telegram"],
      },
      "send_chat_message",
      { platform: "telegram", to: "chat-1", message: "hello" }
    );

    expect(send).toHaveBeenCalledWith("telegram", "chat-1", "hello");
    expect(text).toMatch(/sent/i);
  });

  it("falls back to the running set when the host cannot report live ones", async () => {
    send.mockClear();

    const text = await call(
      { runningPlatforms: () => ["whatsapp"] },
      "send_chat_message",
      { platform: "whatsapp", to: "chat-1", message: "hello" }
    );

    expect(send).toHaveBeenCalled();
    expect(text).toMatch(/sent/i);
  });

  it("still refuses a platform that is not running at all", async () => {
    send.mockClear();

    const text = await call(
      {
        runningPlatforms: () => ["telegram"],
        livePlatforms: () => ["telegram"],
      },
      "send_chat_message",
      { platform: "whatsapp", to: "chat-1", message: "hello" }
    );

    expect(text).toMatch(/whatsapp is not connected/i);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("reading from a platform that is not linked", () => {
  it("blames the connection, not how the user named the chat", async () => {
    // History is stored, so an empty read is fine while a platform is down,
    // but "try naming the exact person" sends the agent asking the user to
    // rename a chat that was never the problem.
    const text = await call(
      {
        runningPlatforms: () => ["whatsapp", "telegram"],
        livePlatforms: () => ["telegram"],
        readMessages: async () => [],
      },
      "read_chat_messages",
      { platform: "whatsapp", chat_id: "chat-1" }
    );

    expect(text).toMatch(/not connected right now/i);
    expect(text).not.toMatch(/naming the exact person/i);
  });

  it("keeps the ordinary empty answer when the platform is linked", async () => {
    const text = await call(
      {
        runningPlatforms: () => ["telegram"],
        livePlatforms: () => ["telegram"],
        readMessages: async () => [],
      },
      "read_chat_messages",
      { platform: "telegram", chat_id: "chat-1" }
    );

    expect(text).toMatch(/naming the exact person/i);
  });
});
