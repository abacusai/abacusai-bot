import path from "node:path";
import { pathToFileURL } from "node:url";

import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * A chat message sent while the bot finishes its answer steers the running
 * turn. The answer it had finished must still reach the chat, once, before
 * the steer's own reply. The gateway used to guess from what it had seen
 * when the message arrived, which is too early: an answer still streaming,
 * or one not wrapped in <reply> (the user's own chat), was replaced by the
 * steer's reply and never sent. The agent knows where the steer landed and
 * says so (`turn_answer`); the gateway sends that.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: "ws",
    botId: "contact-bot",
    autoReplyBootstrapped: true,
    autoReplyPausedUntil: 0,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => id === "whatsapp",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "whatsapp",
  approvedUserIds: () => new Set(["ME", "U1"]),
  findPairing: () => null,
  recordPairingRequest: () => {},
  approvePairing: () => {},
  listPairing: () => [],
}));

// The agent's own reply tracker, outside desktop's TS project: loaded at runtime.
type TurnReplyLike = {
  begin(messageId?: string): void;
  answers(messageId?: string): Record<string, unknown> | null;
  messageStarted(): void;
  textStreamed(text: string): void;
  messageEnded(calledTool: boolean): void;
  take(): Record<string, unknown> | null;
};
const { TurnReply } = (await import(
  pathToFileURL(path.resolve("../../packages/agent/src/forever/turn-reply.ts"))
    .href
)) as { TurnReply: new () => TurnReplyLike };

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { gatewayTurns } = await import("./messaging-turns.test-support");

/**
 * One session's agent, as far as replies go: a send opens a turn, a send
 * while it runs is a steer that lands at the next step boundary (after the
 * message being written), and the real TurnReply decides what it reports.
 */
const fakeAgent = (emit: (event: Record<string, unknown>) => void) => {
  const reply = new TurnReply();
  const steers: string[] = [];
  let running = false;
  let messages = 0;
  const landSteers = (): void => {
    for (const id of steers.splice(0)) {
      const answered = reply.answers(id);
      if (answered != null) emit(answered);
      emit({ type: "user_message_steered", content: "", messageId: id });
    }
  };
  return {
    received: (messageId?: string): void => {
      if (running) {
        if (messageId != null) steers.push(messageId);
        return;
      }
      running = true;
      reply.begin(messageId);
    },
    /** Streams one assistant message's words. */
    stream: (words: string): void => {
      const id = `m${++messages}`;
      reply.messageStarted();
      for (const chunk of words.match(/.{1,8}/gs) ?? []) {
        reply.textStreamed(chunk);
        emit({ type: "text_delta", content: chunk, messageId: id });
      }
    },
    /** The message ends; a steer that arrived meanwhile lands after it. */
    finish: (calledTool = false): void => {
      if (calledTool) emit({ type: "tool_call_start", toolName: "memory" });
      reply.messageEnded(calledTool);
      landSteers();
    },
    end: (): void => {
      const taken = reply.take();
      if (taken != null) emit(taken);
      running = false;
      emit({ type: "status_changed", status: AgentStatus.Idle });
    },
  };
};

const harness = () => {
  const sent: string[] = [];
  const turns = gatewayTurns(() => gateway);
  const agents = new Map<string, ReturnType<typeof fakeAgent>>();
  const agent = (sessionId: string) => {
    let found = agents.get(sessionId);
    if (found == null) {
      found = fakeAgent((event) => turns.emit(sessionId, event));
      agents.set(sessionId, found);
    }
    return found;
  };
  const gateway = new MessagingGatewayService({
    homeBots: {
      get: () => "home-bot",
      set: () => {},
      ensure: () => "home-bot",
    },
    openBotChat: async (botId: string) => ({
      botId,
      workspaceId: "ws",
      sessionId: `${botId}-chat`,
    }),
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => ({ id: "session-1" }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (
      _w: string,
      sessionId: string,
      _message: string,
      _userText: unknown,
      messageId?: string
    ) => {
      turns.sent(sessionId);
      agent(sessionId).received(messageId);
    },
    emitUserMessage: () => {},
    emitAgentMessage: () => {},
    emitChanged: () => {},
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async (_chatId: string, text: string) => {
        sent.push(text);
      },
      selfChatId: () => "ME",
    }
  );
  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };
  return {
    sent,
    /** The user's own chat (home bot) or a contact's (auto-reply bot). */
    lane: (who: "owner" | "contact") => {
      const userId = who === "owner" ? "ME" : "U1";
      return {
        inbound: (text: string) =>
          internals.handleInbound("whatsapp", {
            userId,
            userName: userId,
            chatId: userId,
            text,
          }),
        agent: () =>
          agent(who === "owner" ? "home-bot-chat" : "contact-bot-chat"),
      };
    },
  };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a message that lands while the bot finishes", () => {
  for (const [lane, answer, steered, expected] of [
    // Unwrapped words in the user's own chat.
    ["owner", "Your calendar is empty.", "4", ["Your calendar is empty.", "4"]],
    // A contact's lane wraps the words to send.
    [
      "contact",
      "Short and kind. <reply>Over 1,300 dead, rescue ongoing.</reply>",
      "<reply>hey! what's up?</reply>",
      ["Over 1,300 dead, rescue ongoing.", "hey! what's up?"],
    ],
  ] as const) {
    for (const when of ["before the answer streams", "after it streamed"]) {
      it(`delivers both answers, once, in order (${lane}, ${when})`, async () => {
        const h = harness();
        const chat = h.lane(lane);
        const agent = () => chat.agent();
        await chat.inbound("first question");
        agent().stream("Let me check.");
        agent().finish(true);
        if (when === "before the answer streams")
          await chat.inbound("second question");
        agent().stream(answer);
        // Seen whole by the gateway, not yet ended at the agent.
        if (when === "after it streamed") await chat.inbound("second question");
        agent().finish();
        agent().stream(steered);
        agent().finish();
        agent().end();
        await flush();

        expect(h.sent).toEqual(expected);
      });
    }
  }

  it("sends no narration when the steer lands mid-work", async () => {
    const h = harness();
    const chat = h.lane("owner");
    await chat.inbound("what is on my calendar?");
    chat.agent().stream("Let me check.");
    await chat.inbound("and tomorrow?");
    chat.agent().finish(true);
    chat.agent().stream("Nothing today or tomorrow.");
    chat.agent().finish();
    chat.agent().end();
    await flush();

    expect(h.sent).toEqual(["Nothing today or tomorrow."]);
  });
});
