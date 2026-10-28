import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { visibleUserText } from "@abacus-ai/contract/transcript/user-text";
/**
 * Inbound delivery to a bot's forever chat.
 *
 * With a bot named in the gateway settings, every approved message lands in
 * that bot's one session, framed with who sent it, serialized across chats
 * that share the session, and answered back to the chat whose message the
 * turn was actually about.
 */
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: "ws",
      botId: "bot-1",
    }),
    isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
    isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
    approvedUserIds: () => new Set(["U1", "U2"]),
    findPairing: () => null,
    recordPairingRequest: () => {},
    listPairing: () => [],
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { gatewayTurns } = await import("./messaging-turns.test-support");

const harness = (intro?: string) => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const prompts: string[] = [];
  const tags: Array<UserTextTags | undefined> = [];
  let opened = 0;

  const turns = gatewayTurns(() => gateway);
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      throw new Error("bot routing must not mint gateway sessions");
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (
      _w: string,
      s: string,
      message: string,
      userText?: UserTextTags
    ) => {
      turns.sent(s);
      prompts.push(message);
      tags.push(userText);
    },
    emitUserMessage: () => {},
    emitChanged: () => {},
    ...(intro != null && {
      openBotSenderChat: async () => ({
        botId: "bot-1",
        workspaceId: "ws-bot",
        sessionId: "bot-chat",
        intro,
      }),
    }),
    openBotChat: async () => {
      opened += 1;
      return { botId: "bot-1", workspaceId: "ws-bot", sessionId: "bot-chat" };
    },
  } as never);

  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "discord",
    {
      id: "discord",
      start: async () => {},
      stop: async () => {},
      sendText: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    }
  );

  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };

  return {
    gateway,
    sent,
    prompts,
    tags,
    openedChats: () => opened,
    inbound: (chatId: string, userId: string, userName: string, text: string) =>
      internals.handleInbound("discord", { userId, userName, chatId, text }),
    delta: (content: string) =>
      turns.emit("bot-chat", { type: "text_delta", content }),
    idle: () =>
      turns.emit("bot-chat", {
        type: "status_changed",
        status: AgentStatus.Idle,
      }),
  };
};

describe("delivering into the bot's chat", () => {
  it("routes to the bot session with the sender framed in", async () => {
    const h = harness();

    await h.inbound("C1", "U1", "Ada", "are we still on for 3pm?");

    expect(h.openedChats()).toBe(1);
    expect(h.prompts).toHaveLength(1);
    // The framing is what this pins. Every auto-reply prompt also carries the
    // one-line reminder that what it writes goes to the sender, restated per
    // turn, because the rules preamble rides only on the first one.
    expect(h.prompts[0]).toContain(
      "[Discord message from Ada] are we still on for 3pm?"
    );
    expect(h.prompts[0]).toContain("[auto-reply]");
    expect(h.tags[0]?.operator?.kind).toBe("auto-reply-reminder");
    expect(visibleUserText(h.prompts[0]!, h.tags[0])).toBe(
      "[Discord message from Ada] are we still on for 3pm?"
    );
  });

  it("answers the chat whose message the turn was about", async () => {
    const h = harness();

    await h.inbound("C1", "U1", "Ada", "hello");
    h.delta("hi Ada!");
    h.idle();

    expect(h.sent).toEqual([{ chatId: "C1", text: "hi Ada!" }]);
  });

  it("serializes chats that share the session, then drains the sibling", async () => {
    const h = harness();

    await h.inbound("C1", "U1", "Ada", "first");
    // A different chat while the bot is mid-turn: queued, not interleaved.
    await h.inbound("C2", "U2", "Ben", "second");

    expect(h.prompts).toHaveLength(1);

    h.delta("answer for Ada");
    h.idle();

    // Ada got her reply, and Ben's queued message became the next turn.
    expect(h.sent).toEqual([{ chatId: "C1", text: "answer for Ada" }]);
    expect(h.prompts[1]).toContain("[Discord message from Ben] second");

    h.delta("answer for Ben");
    h.idle();

    expect(h.sent[1]).toEqual({ chatId: "C2", text: "answer for Ben" });
  });

  it("steers the running turn with a follow-up from the same chat", async () => {
    const h = harness();

    await h.inbound("C1", "U1", "Ada", "book me a table for 8");
    // Same chat, mid-turn: sent straight through, so the host steers the
    // turn with it instead of answering the first message and then this one.
    await h.inbound("C1", "U1", "Ada", "make that 9, actually");

    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toBe(
      "[Discord message from Ada] make that 9, actually"
    );

    h.delta("Done: 9pm.");
    h.idle();

    // One reply for the whole exchange, to the chat that asked.
    expect(h.sent).toEqual([{ chatId: "C1", text: "Done: 9pm." }]);
  });

  it("still queues a sibling chat behind the turn it does not own", async () => {
    const h = harness();

    await h.inbound("C1", "U1", "Ada", "first");
    for (let i = 0; i < 10; i += 1) await h.inbound("C2", "U2", "Ben", `b${i}`);

    const route = (
      h.gateway as unknown as { routes: Map<string, { queue: unknown[] }> }
    ).routes.get("discord:C2")!;
    // Ben's messages are a different conversation, not a correction to
    // Ada's, so they wait rather than steer her turn.
    expect(route.queue.length).toBe(10);
    expect(h.prompts).toHaveLength(1);
  });
});

it("tags the sender intro and later reminder at the framed message boundary", async () => {
  const intro = "[auto-reply] rules 😀 for this sender";
  const h = harness(intro);
  await h.inbound("C1", "U1", "Ada", "hello\n\nnext paragraph");
  // Between the rules and the message: where the answer lands, and what
  // never goes there.
  const note =
    "[Replying in Discord] Never give a file path, a localhost or 127.0.0.1 " +
    "link, or point to a card: none of these open on their phone, and no file is sent to them.";
  expect(h.prompts[0]).toBe(
    `${intro}\n\n${note}\n\n[Discord message from Ada] hello\n\nnext paragraph`
  );
  expect(h.tags[0]).toEqual({
    operator: {
      kind: "auto-reply-intro",
      visibleFrom: intro.length + note.length + 4,
    },
  });
  expect(visibleUserText(h.prompts[0]!, h.tags[0])).toBe(
    "[Discord message from Ada] hello\n\nnext paragraph"
  );
  h.idle();
  await h.inbound("C1", "U1", "Ada", "second");
  expect(h.tags[1]?.operator?.kind).toBe("auto-reply-reminder");
  expect(visibleUserText(h.prompts[1]!, h.tags[1])).toBe(
    "[Discord message from Ada] second"
  );
});
