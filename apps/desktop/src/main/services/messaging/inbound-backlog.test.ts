/**
 * Messages that arrived while the app was closed or the computer asleep used
 * to be dropped: every lane seeded "seen" on its first sweep after a connect.
 * Each lane now keeps a watermark, and on connect the gateway answers what
 * came in since it, within 6 h and 10 chats, skipping chats the user already
 * answered from the phone and anything the live path already handed over;
 * the rest gets one line to the user.
 */
import type {
  MessagingPlatformId,
  MessagingPlatformState,
} from "@abacus-ai/contract/messaging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BacklogChat } from "./connector";

const stored = vi.hoisted(() => ({
  seen: null as unknown,
  log: [] as unknown[],
}));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => structuredClone(stored.log),
  writeStoredMessageLog: () => {},
  readStoredOutbox: () => null,
  writeStoredOutbox: () => {},
  readStoredSeen: () => structuredClone(stored.seen),
  writeStoredSeen: (state: unknown) => {
    stored.seen = structuredClone(state);
  },
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
    autoReplyPausedUntil: 0,
  }),
  isPlatformEnabled: () => false,
  isPlatformConfigured: () => false,
  approvedUserIds: () => new Set(["ana", "ben", "me"]),
  findPairing: () => null,
  recordPairingRequest: () => {},
  listPairing: () => [],
}));
vi.mock("./page-boot-watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./page-boot-watch")>()),
  watchLaneHints: () => () => {},
  userActive: () => false,
}));
vi.mock("@abacus-ai/agent/user-language", () => ({
  readUserLanguage: () => null,
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 9, 20, 0);

/** A WhatsApp lane whose catch-up read answers `backlog`, and what reached the gateway. */
const lane = (backlog: (since: number) => BacklogChat[]) => {
  const turns: Array<{ chatId: string; text: string }> = [];
  const sent: Array<[string, string]> = [];
  const reads: number[] = [];
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    now: () => Date.now(),
  } as never);
  const internals = gateway as unknown as {
    connectors: Map<string, unknown>;
    setState: (id: string, state: MessagingPlatformState) => void;
    handleInbound: (
      id: MessagingPlatformId,
      message: { chatId: string; text: string; id?: string; userId: string }
    ) => Promise<void>;
  };
  // What the catch-up hands to the normal inbound path (its gate is tested elsewhere).
  const real = internals.handleInbound.bind(gateway);
  internals.handleInbound = async (_id, message) => {
    turns.push(message);
  };
  internals.connectors.set("whatsapp", {
    id: "whatsapp",
    start: async () => {},
    stop: async () => {},
    selfChatId: () => "me",
    sendText: async (chatId: string, text: string) => {
      sent.push([chatId, text]);
    },
    backlog: async (since: number, maxChats: number) => {
      reads.push(since);
      return backlog(since).map((chat, index) =>
        index < maxChats
          ? chat
          : { ...chat, messages: [], unread: true as const }
      );
    },
  });
  return {
    gateway,
    turns,
    sent,
    reads,
    connect: async () => {
      internals.setState("whatsapp", "connected");
      await vi.advanceTimersByTimeAsync(50);
    },
    disconnect: () => internals.setState("whatsapp", "connecting"),
    live: async (id: string, text: string) => {
      turns.push({ chatId: "ana", text });
      await real("whatsapp", { userId: "ana", chatId: "ana", text, id });
    },
  };
};

const chat = (
  id: string,
  messages: Array<[string, number, string]>,
  answered = false
): BacklogChat => ({
  chatId: id,
  userId: id,
  userName: id,
  answered,
  messages: messages.map(([mid, at, text]) => ({ id: mid, at, text })),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  stored.seen = null;
  stored.log = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("catch-up after a gap", () => {
  it("replays nothing on a lane's first connect ever", async () => {
    const h = lane(() => [chat("ana", [["m1", NOW - HOUR, "old unread"]])]);
    await h.connect();
    expect(h.reads).toEqual([]);
    expect(h.turns).toEqual([]);
  });

  it("answers each chat's late messages once, as one turn with a late note", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 3 * HOUR, ids: [] } };
    const h = lane(() => [
      chat("ana", [
        ["m1", NOW - 2 * HOUR, "are you free?"],
        ["m2", NOW - 2 * HOUR + 60_000, "for the interview"],
      ]),
    ]);
    await h.connect();

    expect(h.reads).toEqual([NOW - 3 * HOUR]);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]?.chatId).toBe("ana");
    expect(h.turns[0]?.text).toMatch(
      /^\[Arrived at .+ while this computer was off or asleep;.+\]\nare you free\?\nfor the interview$/
    );

    // Relaunched: the same messages are known and answered again by nobody.
    h.disconnect();
    await h.connect();
    expect(h.turns).toHaveLength(1);
  });

  it("skips a chat the user answered from the phone, by its newest message or the log", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 3 * HOUR, ids: [] } };
    stored.log = [
      {
        platform: "whatsapp",
        chatId: "ben",
        userId: "me",
        userName: null,
        text: "on it",
        direction: "out",
        at: new Date(NOW - HOUR).toISOString(),
      },
    ];
    const h = lane(() => [
      chat("ana", [["m1", NOW - 2 * HOUR, "hi"]], true),
      chat("ben", [["m2", NOW - 2 * HOUR, "hey"]]),
    ]);
    await h.connect();
    expect(h.turns).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("never delivers a message the live path already handed over", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - HOUR, ids: [] } };
    const h = lane(() => [chat("ana", [["m1", NOW - 30_000, "live one"]])]);
    await h.live("m1", "live one");
    await h.connect();
    // The live delivery only; the catch-up found it known.
    expect(h.turns.map((turn) => turn.text)).toEqual(["live one"]);
  });

  it("answers at most 10 chats and tells the user once about the rest and the too-old", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 9 * HOUR, ids: [] } };
    const recent = Array.from({ length: 12 }, (_, i) =>
      chat(`c${i}`, [[`r${i}`, NOW - HOUR, `msg ${i}`]])
    );
    const old = chat("ana", [["o1", NOW - 8 * HOUR, "from this morning"]]);
    const h = lane(() => [...recent, old]);
    await h.connect();

    // Ten answered; two over the cap and one older than 6 h are only reported.
    expect(h.turns).toHaveLength(10);
    expect(h.sent).toEqual([
      [
        "me",
        "3 chats wrote while the computer was off or asleep; I haven't answered them.",
      ],
    ]);
  });
});
