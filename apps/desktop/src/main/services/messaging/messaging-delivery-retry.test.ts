/**
 * A reply that fails to deliver is retried, and a failure that survives the
 * retries is recorded, never dropped. One console line was all a failed
 * delivery used to leave: the sender chat showed the reply as sent, the
 * recipient got nothing, and nobody knew.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => [],
  writeStoredMessageLog: () => {},
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const service = (
  sendText: (chatId: string, text: string) => Promise<void>
): InstanceType<typeof MessagingGatewayService> => {
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    { id: "whatsapp", start: async () => {}, stop: async () => {}, sendText }
  );
  return gateway;
};

const send = (
  gateway: InstanceType<typeof MessagingGatewayService>
): Promise<void> =>
  (
    gateway as unknown as {
      safeSend: (
        platformId: MessagingPlatformId,
        chatId: string,
        text: string
      ) => Promise<void>;
    }
  ).safeSend("whatsapp", "School friendsss", "Hey! How's it going?");

const loggedIn = (
  gateway: InstanceType<typeof MessagingGatewayService>
): Array<{ text: string; direction: string }> =>
  (
    gateway as unknown as {
      messageLog: Array<{ text: string; direction: string }>;
    }
  ).messageLog;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-reply delivery", () => {
  it("retries a failed send and records the delivery, not the failure", async () => {
    let attempts = 0;
    const gateway = service(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("stale page");
    });

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(16_000);
    await done;

    expect(attempts).toBe(2);
    // One row, the words that went out: the traffic view and
    // read_chat_messages used to show only the other side of a conversation.
    const rows = loggedIn(gateway);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("out");
    expect(rows[0]?.text).not.toContain("[NOT DELIVERED]");
  });

  it("records a delivery that failed every attempt", async () => {
    let attempts = 0;
    const gateway = service(async () => {
      attempts += 1;
      throw new Error("the chat did not load");
    });

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;

    expect(attempts).toBe(3);
    const rows = loggedIn(gateway);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("[NOT DELIVERED]");
    expect(rows[0]?.text).toContain("the chat did not load");
  });
});
