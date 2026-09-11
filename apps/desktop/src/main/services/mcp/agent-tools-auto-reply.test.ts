/**
 * `auto_reply`: "reply whenever X messages me" as one tool call.
 *
 * Bots-only — routing inbound messages to the calling bot's own
 * chat needs a calling bot. The user naming a sender in the bot's chat is the
 * approval the pairing queue exists to collect, so allowing them here skips
 * the queue; strangers stay unanswered either way.
 */
import { describe, expect, it, vi } from "vitest";

import type { SenderCandidate } from "../messaging/sender-resolution";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";

const candidate = (name: string, userId: string): SenderCandidate => ({
  platform: "whatsapp",
  userId,
  chatId: userId,
  name,
});

const gateway = () => ({
  status: vi.fn(() => ({
    respondToInbound: false,
    botId: null as string | null,
    approved: [] as Array<{
      platform: "whatsapp";
      userId: string;
      name: string;
    }>,
    pending: [] as Array<{
      platform: "whatsapp";
      userId: string;
      name: string;
    }>,
  })),
  enable: vi.fn(),
  disable: vi.fn(),
  senderCandidates: vi.fn(() => [
    candidate("Alex Fischer", "491701@c.us"),
    candidate("Alexandra", "491702@c.us"),
    candidate("Mom", "491703@c.us"),
  ]),
  allowSender: vi.fn(),
  removeSender: vi.fn(),
});

/** `bot-session` belongs to a bot; every other session id does not. */
const server = (
  autoReply = gateway(),
  platforms: string[] = ["whatsapp"]
): {
  instance: McpAgentToolsServer;
  autoReply: ReturnType<typeof gateway>;
} => ({
  autoReply,
  instance: new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    botIdForSession: (sessionId: string) =>
      sessionId === "bot-session" ? "bot-1" : null,
    messaging: {
      runningPlatforms: () => platforms,
      listChats: () => [],
      send: async () => undefined,
      readMessages: async () => [],
      autoReply,
    },
  } as never),
});

const call = async (
  instance: McpAgentToolsServer,
  args: Record<string, unknown>,
  session?: string
): Promise<string> => {
  const result = await (
    instance as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("auto_reply", args, session);

  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("turning auto-reply on from a bot's chat", () => {
  it("enables delivery to the calling bot and allows the named sender", async () => {
    const { instance, autoReply } = server();

    const text = await call(
      instance,
      { action: "on", sender: "alex fischer" },
      "bot-session"
    );

    expect(autoReply.enable).toHaveBeenCalledWith("bot-1");
    expect(autoReply.allowSender).toHaveBeenCalledWith(
      candidate("Alex Fischer", "491701@c.us"),
      "bot-1"
    );
    expect(text).toContain("Auto-reply is on");
    expect(text).toContain("Alex Fischer");
  });

  it("turns on without a sender, saying one is still needed", async () => {
    const { instance, autoReply } = server();

    const text = await call(instance, { action: "on" }, "bot-session");

    expect(autoReply.enable).toHaveBeenCalledWith("bot-1");
    expect(autoReply.allowSender).not.toHaveBeenCalled();
    expect(text).toContain("No sender allowed yet");
  });

  it("infers the platform when exactly one is connected", async () => {
    const { instance, autoReply } = server();

    await call(instance, { action: "on", sender: "mom" }, "bot-session");

    expect(autoReply.senderCandidates).toHaveBeenCalledWith("whatsapp");
  });

  it("asks which platform when several are connected", async () => {
    const { instance, autoReply } = server(gateway(), ["whatsapp", "telegram"]);

    const text = await call(
      instance,
      { action: "on", sender: "mom" },
      "bot-session"
    );

    expect(text).toContain("say which one");
    expect(autoReply.enable).not.toHaveBeenCalled();
  });

  it("reports an ambiguous name instead of guessing", async () => {
    const { instance, autoReply } = server();

    const text = await call(
      instance,
      { action: "on", sender: "alex" },
      "bot-session"
    );

    expect(text).toContain("matches several people");
    expect(autoReply.allowSender).not.toHaveBeenCalled();
    expect(autoReply.enable).not.toHaveBeenCalled();
  });

  it("says what to do about an unknown name", async () => {
    const { instance } = server();

    const text = await call(
      instance,
      { action: "on", sender: "boss" },
      "bot-session"
    );

    expect(text).toContain("send one message");
  });
});

describe("the other actions", () => {
  it("allow_sender adds without flipping the switch", async () => {
    const { instance, autoReply } = server();

    await call(
      instance,
      { action: "allow_sender", sender: "mom" },
      "bot-session"
    );

    expect(autoReply.allowSender).toHaveBeenCalledWith(
      candidate("Mom", "491703@c.us"),
      "bot-1"
    );
    expect(autoReply.enable).not.toHaveBeenCalled();
  });

  it("remove_sender revokes", async () => {
    const { instance, autoReply } = server();

    const text = await call(
      instance,
      { action: "remove_sender", sender: "mom" },
      "bot-session"
    );

    expect(autoReply.removeSender).toHaveBeenCalledWith(
      candidate("Mom", "491703@c.us")
    );
    expect(text).toContain("no longer be answered");
  });

  it("off disables and keeps the allowlist", async () => {
    const { instance, autoReply } = server();

    const text = await call(instance, { action: "off" }, "bot-session");

    expect(autoReply.disable).toHaveBeenCalled();
    expect(text).toContain("kept for next time");
  });

  it("status names the allowed senders", async () => {
    const autoReply = gateway();
    autoReply.status.mockReturnValue({
      respondToInbound: true,
      botId: "bot-1",
      approved: [{ platform: "whatsapp", userId: "1", name: "Alex" }],
      pending: [],
    });
    const { instance } = server(autoReply);

    const text = await call(instance, { action: "status" }, "bot-session");

    expect(text).toContain("Auto-reply is on");
    expect(text).toContain("Alex (whatsapp)");
  });
});

describe("who may call it", () => {
  it("is refused outside a bot's chat", async () => {
    const { instance, autoReply } = server();

    const text = await call(instance, { action: "on" }, "session-1");

    expect(text).toContain("only available in a bot's chat");
    expect(autoReply.enable).not.toHaveBeenCalled();
  });

  it("points at Connectors when no platform is running", async () => {
    const { instance } = server(gateway(), []);

    const text = await call(instance, { action: "on" }, "bot-session");

    expect(text).toContain("No messaging platform is connected");
  });
});
