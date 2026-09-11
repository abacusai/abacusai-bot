/**
 * Only the turn's last assistant message is the reply.
 *
 * The report: Ma asked about the weather and received, verbatim, "Let me
 * check the weather for you." — the narration before the web search — then
 * the model's planning, then the actual reply. A turn that calls a tool
 * produces several assistant messages; the words for the other person are
 * the ones after the last tool round, and nothing before them.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readStoredMessageLog: () => [],
    writeStoredMessageLog: () => {},
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: null,
    }),
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

type Event =
  | { type: "text_delta"; content: string; messageId?: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string }
  | { type: "status_changed"; status: "idle" };

const replyAfter = (events: Event[]): string[] => {
  const service = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  const sent: string[] = [];
  const internals = service as unknown as {
    routesBySession: Map<string, unknown>;
    routes: Map<string, unknown>;
    handleAgentEvent: (sessionId: string, payload: unknown) => void;
    safeSend: (
      platform: string,
      chatId: string,
      text: string,
      context: unknown
    ) => Promise<void>;
  };
  internals.safeSend = async (_platform, _chatId, text) => {
    sent.push(text);
  };
  const route = {
    platform: "whatsapp",
    chatId: "Ma",
    sessionId: "s1",
    workspaceId: "w",
    userId: "Ma",
    buffer: "",
    bufferMessageId: null,
    busy: true,
    busySince: Date.now(),
    queue: [],
    queueFullNotified: false,
    viaBot: true,
    senderLabel: "",
    pendingIntro: null,
  };
  internals.routesBySession.set("s1", route);
  internals.routes.set("whatsapp:Ma", route);

  for (const event of events)
    internals.handleAgentEvent("s1", { type: "event", event });
  return sent;
};

describe("which words reach the other person", () => {
  it("drops the narration before a tool call and keeps the reply after it", () => {
    const sent = replyAfter([
      {
        type: "text_delta",
        content: "Let me check the weather for you.",
        messageId: "a",
      },
      { type: "tool_call_start", toolCallId: "t1", toolName: "web_search" },
      {
        type: "text_delta",
        content: "Hey! Which city are you in?",
        messageId: "b",
      },
      { type: "status_changed", status: "idle" },
    ]);
    expect(sent).toEqual(["Hey! Which city are you in?"]);
  });

  it("keeps only the latest assistant message even without a tool call", () => {
    const sent = replyAfter([
      { type: "text_delta", content: "Thinking about this…", messageId: "a" },
      {
        type: "text_delta",
        content: "khawa hoye geche, tumi?",
        messageId: "b",
      },
      { type: "status_changed", status: "idle" },
    ]);
    expect(sent).toEqual(["khawa hoye geche, tumi?"]);
  });

  it("leaves a plain one-message reply exactly as written", () => {
    const sent = replyAfter([
      { type: "text_delta", content: "Hi ", messageId: "a" },
      { type: "text_delta", content: "Ma!", messageId: "a" },
      { type: "status_changed", status: "idle" },
    ]);
    expect(sent).toEqual(["Hi Ma!"]);
  });
});
