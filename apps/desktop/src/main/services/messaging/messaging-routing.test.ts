/**
 * What happens to a conversation between turns.
 *
 * Both cases here are silent from the sender's side, which is what makes them
 * worth pinning: a message that is neither answered nor refused looks exactly
 * like an agent thinking.
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
    // One approved sender, so inbound reaches routing rather than pairing.
    approvedUserIds: () => new Set(["U1"]),
    findPairing: () => null,
    recordPairingRequest: () => {},
    listPairing: () => [],
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

type Harness = {
  gateway: InstanceType<typeof MessagingGatewayService>;
  sent: string[];
  prompts: string[];
  sessionsCreated: () => number;
  inbound: (text: string) => Promise<void>;
  idle: () => void;
  sessionId: () => string;
};

const harness = (): Harness => {
  const sent: string[] = [];
  const prompts: string[] = [];
  let created = 0;
  let currentSession = "";

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      created += 1;
      currentSession = `session-${created}`;
      return { id: currentSession } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (_w: string, _s: string, message: string) =>
      prompts.push(message),
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  // A connector that records replies instead of sending them.
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

  return {
    gateway,
    sent,
    prompts,
    sessionsCreated: () => created,
    sessionId: () => currentSession,
    inbound: (text: string) =>
      internals.handleInbound("discord", {
        userId: "U1",
        userName: "Someone",
        chatId: "C1",
        text,
      }),
    idle: () =>
      gateway.handleAgentEvent(currentSession, {
        type: "event",
        event: { type: "status_changed", status: AgentStatus.Idle },
      } as never),
  };
};

describe("messages arriving while the agent is working", () => {
  // A follow-up from the chat whose turn is running goes straight through:
  // the host steers the turn with it, so the model hears "actually, make it
  // shorter" before the long answer ships. Nothing queues, nothing is refused.
  it("sends follow-ups from the same chat into the running turn, in order", async () => {
    const h = harness();
    await h.inbound("first");
    expect(h.prompts).toEqual(["first"]);

    // Ten, not more: the loop breaker caps one chat's bursts on its own.
    for (let i = 0; i < 10; i += 1) await h.inbound(`follow-up ${i}`);

    const route = (
      h.gateway as unknown as { routes: Map<string, { queue: unknown[] }> }
    ).routes.get("discord:C1")!;
    expect(route.queue.length).toBe(0);
    expect(h.prompts).toHaveLength(11);
    expect(h.prompts[10]).toBe("follow-up 9");
    expect(h.sent.filter((t) => t.includes("didn't get queued"))).toHaveLength(
      0
    );
  });

  it("starts nothing new at idle when everything already went through", async () => {
    const h = harness();
    await h.inbound("first");
    await h.inbound("second");

    h.idle();

    expect(h.prompts).toEqual(["first", "second"]);
  });
});
