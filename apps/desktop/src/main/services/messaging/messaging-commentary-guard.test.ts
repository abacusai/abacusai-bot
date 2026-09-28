/**
 * The last door before a reply reaches someone who is not the user.
 *
 * The report: asked about a news story, the bot sent the group a numbered
 * menu: "1. Answer as you: tell me your take and I'll send it in your
 * casual style", addressed to the user, delivered to everyone in the chat.
 * The preamble forbids that in terms: "no status notes, no commentary, no
 * questions meant for the user". The model did it anyway.
 *
 * An instruction a model can forget is not a guarantee, and the one thing
 * this feature must never do is talk to the wrong person in the user's name.
 * So the door checks, and it checks for machine-shaped phrases rather than
 * for tone; judgement is what already failed.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: null,
    }),
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

/** Flush one buffered reply and report what actually went out. */
const flushed = (reply: string): string | null => {
  const service = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  let sent: string | null = null;
  const internals = service as unknown as {
    flushReply: (route: unknown) => void;
    safeSend: (
      platform: string,
      chatId: string,
      text: string,
      context: unknown
    ) => Promise<void>;
  };
  internals.safeSend = async (_platform, _chatId, text) => {
    sent = text;
  };

  internals.flushReply({
    platform: "whatsapp",
    chatId: "Girlies",
    buffer: reply,
    replyContext: null,
  });

  return sent;
};

describe("a reply that is talking to the user", () => {
  it("does not reach the contact", () => {
    const sent = flushed(
      "I'm set up to answer chats in your voice. Do you want me to answer as " +
        "you, or should the user handle this one?"
    );

    expect(sent).not.toContain("the user");
    expect(sent).not.toContain("in your voice");
  });

  it("sends the deferral instead of nothing", () => {
    // Silence on a real message reads as the user ignoring them, which the
    // preamble is more careful about than almost anything else.
    expect(flushed("Should I keep auto-reply on for serious topics?")).toBe(
      "let me get back to you on that"
    );
  });

  it("never leaks the sentinel into a chat", () => {
    expect(flushed("NO_REPLY, this looks automated")).toBe(
      "let me get back to you on that"
    );
  });

  it("catches the menu from the report", () => {
    const sent = flushed(
      "I appreciate the message, but I should clarify something: I'm set up " +
        "to answer chats in your voice and style. Do you want me to: 1. " +
        "Answer as you 2. Skip this one 3. Keep auto-reply off for serious " +
        "topics. What works best?"
    );

    expect(sent).toBe("let me get back to you on that");
  });
});

describe("an ordinary reply", () => {
  it("goes out untouched", () => {
    expect(flushed("lol she's probably working, she'll be back soon")).toBe(
      "lol she's probably working, she'll be back soon"
    );
  });

  it("is not caught by talking about users in general", () => {
    // The markers have to be machine-shaped, not merely topical: a false
    // positive replaces a real answer with a deferral.
    expect(flushed("the users on that app are so annoying lol")).toBe(
      "the users on that app are so annoying lol"
    );
  });

  it("is not caught by a question meant for the contact", () => {
    expect(flushed("do you want me to bring snacks?")).toBe(
      "do you want me to bring snacks?"
    );
  });

  it("still sends nothing for the bare sentinel", () => {
    expect(flushed("NO_REPLY")).toBeNull();
  });
});
