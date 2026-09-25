/**
 * What a remote user is told when the agent reports an error after answering.
 *
 * Not every provider failure lands mid-turn. The agent reads the failure off
 * pi's state once `prompt()` has resolved, which is after the turn's idle
 * event, so an error can arrive at a route that has already flushed its reply
 * and gone free. Forwarding one sent a second chat message holding nothing but
 * raw provider text ("Provider finish_reason: MALFORMED_FUNCTION_CALL"), about
 * a turn that had in fact just answered the question correctly.
 */
import { describe, expect, it, vi } from "vitest";

import { AgentStatus } from "#shared/agent-types";
import type { MessagingPlatformId } from "#shared/messaging";

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
    }),
    isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
    isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
    approvedUserIds: () => new Set(["U1"]),
    findPairing: () => null,
    recordPairingRequest: () => {},
    listPairing: () => [],
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const harness = () => {
  const sent: string[] = [];
  let currentSession = "";
  let created = 0;

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      created += 1;
      currentSession = `session-${created}`;
      return { id: currentSession } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "discord",
    {
      id: "discord",
      start: async () => {},
      stop: async () => {},
      sendText: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    }
  );

  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };

  const emit = (event: Record<string, unknown>): void =>
    gateway.handleAgentEvent(currentSession, { type: "event", event } as never);

  return {
    sent,
    inbound: (text: string) =>
      internals.handleInbound("discord", {
        userId: "U1",
        userName: "Someone",
        chatId: "C1",
        text,
      }),
    say: (content: string) => emit({ type: "text_delta", content }),
    idle: () => emit({ type: "status_changed", status: AgentStatus.Idle }),
    fail: (message: string) => emit({ type: "error", error: { message } }),
    failWith: (error: Record<string, unknown>) =>
      emit({ type: "error", error }),
  };
};

describe("a model the desktop cannot run", () => {
  it("tells the phone to sign in, not what pi said", async () => {
    const h = harness();
    await h.inbound("Hey");

    // What a bot spawned during sign-out produced: pi's /login hint, with
    // the profile's filesystem paths, went out as the bot's reply.
    h.failWith({
      message:
        "No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /Users/x/.abacusai-bot/profiles/p/agent/docs/providers.md",
      code: "model_unavailable",
    });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("not signed in to Abacus.AI");
    expect(h.sent[0]).not.toContain("/login");
    expect(h.sent[0]).not.toContain("providers.md");
  });

  it("still relays an error that is not about the model", async () => {
    const h = harness();
    await h.inbound("Hey");

    h.failWith({ message: "402: out of credit" });

    expect(h.sent).toEqual(["402: out of credit"]);
  });
});

describe("an error that arrives after the turn ended", () => {
  it("does not send the raw provider text as its own message", async () => {
    const h = harness();
    await h.inbound("what is 78999 * 35678?");
    h.say("The result of 78999 * 35678 is 2818526322.");
    h.idle();

    h.fail("Provider finish_reason: MALFORMED_FUNCTION_CALL");

    // The regression: two messages, the second one just the provider string.
    expect(h.sent).toEqual(["The result of 78999 * 35678 is 2818526322."]);
  });

  it("leaves the answer that was already delivered alone", async () => {
    const h = harness();
    await h.inbound("hello");
    h.say("Hi!");
    h.idle();
    h.fail("Provider finish_reason: MALFORMED_FUNCTION_CALL");

    expect(h.sent).toHaveLength(1);
  });
});

describe("an error that arrives mid-turn", () => {
  it("still reaches the user, with whatever the agent had produced", async () => {
    // The case the error branch exists for: silence is worse than a raw
    // provider string, because the sender has no other way to find out.
    const h = harness();
    await h.inbound("do the thing");
    h.say("Starting…");

    h.fail("402: out of credit");

    expect(h.sent).toEqual(["Starting…\n\n402: out of credit"]);
  });

  it("reports a failure that produced nothing at all", async () => {
    const h = harness();
    await h.inbound("do the thing");

    h.fail("402: out of credit");

    expect(h.sent).toEqual(["402: out of credit"]);
  });
});
