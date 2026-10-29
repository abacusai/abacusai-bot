import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * A reply that fails to deliver is retried, and a failure that survives the
 * retries is recorded, never dropped. One console line was all a failed
 * delivery used to leave: the sender chat showed the reply as sent, the
 * recipient got nothing, and nobody knew. What still fails is kept and tried
 * again later, and given up on only with the user told.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({
  outbox: null as { pending: unknown[]; done: string[] } | null,
}));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => [],
  writeStoredMessageLog: () => {},
  readStoredOutbox: () => stored.outbox,
  writeStoredOutbox: (state: { pending: unknown[]; done: string[] }) => {
    stored.outbox = structuredClone(state);
  },
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { ChatOutbox } = await import("./messaging-outbox");
const { UndeliverableChatError } = await import("./connector");

const service = (
  sendText: (chatId: string, text: string) => Promise<void>,
  selfChatId?: string
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
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText,
      selfChatId: () => selfChatId ?? null,
    }
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
  stored.outbox = null;
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

describe("a message that still could not go", () => {
  it("is kept on disk and goes on a later try", async () => {
    let down = true;
    const sent: string[] = [];
    const gateway = service(async (_chatId, text) => {
      if (down) throw new Error("offline");
      sent.push(text);
    });

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;
    expect(stored.outbox?.pending).toHaveLength(1);

    down = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(sent).toEqual(["Hey! How's it going?"]);
    expect(stored.outbox?.pending).toEqual([]);
    expect(loggedIn(gateway).at(-1)?.text).toBe("Hey! How's it going?");
  });

  it("is tried again when its platform connects, without waiting", async () => {
    let down = true;
    const sent: string[] = [];
    const gateway = service(async (_chatId, text) => {
      if (down) throw new Error("offline");
      sent.push(text);
    });
    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;

    down = false;
    (
      gateway as unknown as {
        setState: (id: string, state: string) => void;
      }
    ).setState("whatsapp", "connected");
    await vi.advanceTimersByTimeAsync(10);

    expect(sent).toEqual(["Hey! How's it going?"]);
  });

  it("is given up on after the last try, and the user's own chat is told", async () => {
    const sent: string[] = [];
    const gateway = service(async (chatId, text) => {
      if (chatId !== "me@self") throw new Error("the chat did not load");
      sent.push(text);
    }, "me@self");

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30 * 60_000 + 1_000);

    expect(stored.outbox?.pending).toEqual([]);
    expect(sent).toEqual(["A message to someone could not be delivered."]);
  });
});

describe("a message owed more than once", () => {
  it("goes once when its platform connects while a retry is on its way", async () => {
    let down = true;
    let release: () => void = () => {};
    const sent: string[] = [];
    const gateway = service(async (_chatId, text) => {
      if (down) throw new Error("offline");
      // The retry is slow to come back: the reconnect lands meanwhile.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      sent.push(text);
    });
    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;

    down = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    (
      gateway as unknown as {
        setState: (id: string, state: string) => void;
      }
    ).setState("whatsapp", "connected");
    await vi.advanceTimersByTimeAsync(10);
    release();
    await vi.advanceTimersByTimeAsync(10);
    release();
    await vi.advanceTimersByTimeAsync(10);

    expect(sent).toEqual(["Hey! How's it going?"]);
    expect(stored.outbox?.pending).toEqual([]);
  });

  it("is owed once by its id, and never again once it went", async () => {
    const sent: string[] = [];
    let state: unknown = null;
    const outbox = new ChatOutbox({
      now: () => 0,
      read: () => state,
      write: (next) => {
        state = structuredClone(next);
      },
      send: async (message) => {
        sent.push(message.text);
        return true;
      },
      giveUp: async () => {},
    });
    const message = {
      id: "turn-1:chat",
      platform: "whatsapp" as const,
      chatId: "Ana",
      text: "The app closed before I could reply.",
      userName: "Ana",
      firstFailedAt: 0,
    };

    expect(outbox.owe(message, 0)).toBe(true);
    expect(outbox.owe(message, 0)).toBe(false);
    await outbox.flush();
    // A replay after a restart, from the file as it was left.
    const replayed = new ChatOutbox({
      now: () => 0,
      read: () => state,
      write: () => {},
      send: async () => true,
      giveUp: async () => {},
    });
    expect(replayed.owe(message, 0)).toBe(false);
    expect(sent).toEqual(["The app closed before I could reply."]);
    outbox.dispose();
    replayed.dispose();
  });
});

describe("a message to a chat that can never take one", () => {
  const refuseStatus =
    (sent: string[]) => async (chatId: string, text: string) => {
      if (chatId === "status@broadcast")
        throw new UndeliverableChatError("not a chat");
      sent.push(`${chatId}: ${text}`);
    };

  it("is tried once and never kept to retry", async () => {
    let attempts = 0;
    const sent: string[] = [];
    const gateway = service(async (chatId, text) => {
      attempts += 1;
      await refuseStatus(sent)(chatId, text);
    }, "me@self");

    const done = (
      gateway as unknown as {
        safeSend: (p: string, c: string, t: string) => Promise<void>;
      }
    ).safeSend("whatsapp", "status@broadcast", "Nice photo!");
    await vi.advanceTimersByTimeAsync(80_000);
    await done;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30 * 60_000 + 1_000);

    expect(attempts).toBe(1);
    expect(stored.outbox?.pending ?? []).toEqual([]);
    expect(sent).toEqual([]);
    expect(loggedIn(gateway)).toEqual([]);
  });

  it("is dropped from the outbox an older build left, without telling anyone", async () => {
    stored.outbox = {
      pending: [
        {
          id: "old-1",
          platform: "whatsapp",
          chatId: "status@broadcast",
          text: "Nice photo!",
          userName: "Ana",
          firstFailedAt: 0,
          tries: 0,
        },
        {
          id: "old-2",
          platform: "whatsapp",
          chatId: "Ana",
          text: "See you at 5",
          userName: "Ana",
          firstFailedAt: 0,
          tries: 0,
        },
      ],
      done: [],
    };
    const sent: string[] = [];
    service(refuseStatus(sent), "me@self");

    await vi.advanceTimersByTimeAsync(61_000);

    expect(stored.outbox?.pending).toEqual([]);
    expect(stored.outbox?.done).toEqual(["old-1", "old-2"]);
    expect(sent).toEqual(["Ana: See you at 5"]);
  });
});
