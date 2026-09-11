/**
 * A reply the model wrapped before a tool call is still the reply.
 *
 * Text before a tool call is treated as narration and dropped, which is
 * right for "Let me check the weather" — but a model that answered "Love
 * you too" inside <reply>, then filed a memory note, ended its turn with
 * nothing after the tool call, and the wrapped answer went with the
 * narration. Nothing was sent, and nothing was logged as failed.
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
    readStoredMessageLog: () => [],
    writeStoredMessageLog: () => {},
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
        userName: "S",
        chatId: "C1",
        text,
      }),
    say: (content: string, messageId?: string) =>
      emit({ type: "text_delta", content, messageId }),
    tool: () => emit({ type: "tool_call_start", toolName: "memory" }),
    idle: () => emit({ type: "status_changed", status: AgentStatus.Idle }),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a reply wrapped before a tool call", () => {
  it("is sent when the turn ends with nothing after the call", async () => {
    const h = harness();
    await h.inbound("Love u");
    h.say("A warm message. <reply>Love you too ❤️</reply>", "m1");
    h.tool();
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Love you too ❤️"]);
  });

  it("gives way to a reply written after the call", async () => {
    const h = harness();
    await h.inbound("weather?");
    h.say("<reply>one sec</reply>", "m1");
    h.tool();
    h.say("<reply>Sunny, 24°.</reply>", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Sunny, 24°."]);
  });

  it("still drops untagged narration before a call", async () => {
    const h = harness();
    await h.inbound("weather?");
    h.say("Let me check the weather for you.", "m1");
    h.tool();
    h.say("<reply>Sunny, 24°.</reply>", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Sunny, 24°."]);
  });

  it("does not carry a reply into the next turn", async () => {
    const h = harness();
    await h.inbound("Love u");
    h.say("<reply>Love you too</reply>", "m1");
    h.tool();
    h.idle();
    await tick();
    await h.inbound("ok");
    h.say("Noted.", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Love you too", "Noted."]);
  });
});
