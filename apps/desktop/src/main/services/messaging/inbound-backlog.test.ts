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

import { type BacklogChat, collectBacklog } from "./connector";

const stored = vi.hoisted(() => ({
  seen: null as unknown,
  log: [] as unknown[],
  approved: new Set<string>(),
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
  approvedUserIds: () => stored.approved,
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
const lane = (
  backlog: (since: number) => BacklogChat[],
  { gate = false } = {}
) => {
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
  // What the catch-up hands to the normal inbound path; `gate` runs that path for real.
  const real = internals.handleInbound.bind(gateway);
  if (!gate)
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
    // The lane's real reading rule over scripted chats: the gateway's `wanted`, own chat first, the cap.
    backlog: async (
      since: number,
      maxChats: number,
      wanted: Parameters<typeof collectBacklog>[4]
    ) => {
      reads.push(since);
      const chats = backlog(since);
      return collectBacklog(
        chats.map((row) => ({
          chatId: row.chatId,
          userId: row.userId,
          name: row.userName,
          own: row.userId === "me",
          kind: row.kind ?? "direct",
        })),
        async (chatId) => {
          const row = chats.find((c) => c.chatId === chatId)!;
          return [
            ...row.messages.map((m) => ({ ...m, direction: "in" as const })),
            ...(row.answered
              ? [{ at: Date.now(), text: "ok", direction: "out" as const }]
              : []),
          ];
        },
        since,
        maxChats,
        wanted
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
    // A live message; with no workspace, each one that passes the gate gets the app's notice.
    live: (id: string, text: string) =>
      real("whatsapp", { userId: "ana", chatId: "ana", text, id }),
  };
};

const chat = (
  id: string,
  messages: Array<[string, number, string]>,
  answered = false,
  kind: "direct" | "group" = "direct"
): BacklogChat => ({
  chatId: id,
  userId: id,
  userName: id,
  kind,
  answered,
  messages: messages.map(([mid, at, text]) => ({ id: mid, at, text })),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  stored.seen = null;
  stored.log = [];
  stored.approved = new Set(["ana", "ben", "me"]);
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
      /^\[late\] Arrived at .+ while this computer was off or asleep;.+\n\nare you free\?\nfor the interview$/
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
    // The store's copy of a message can read differently from the live event's: the id decides.
    // Dated after the app's own notice to Ana, so only the id can tell it was handled.
    const h = lane(() => [chat("ana", [["m1", NOW + 10, "live one 🙂"]])]);
    await h.live("m1", "live one");
    await h.connect();
    expect(h.sent.filter(([to]) => to === "ana")).toHaveLength(1);
    expect(h.turns).toEqual([]);
  });

  it("answers a message the live path hands over twice only once", async () => {
    const h = lane(() => []);
    await h.live("m1", "hello");
    await h.live("m1", "hello");
    expect(h.sent.filter(([to]) => to === "ana")).toHaveLength(1);
  });

  it("goes through the normal sender gate: an unknown sender is not answered", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 3 * HOUR, ids: [] } };
    const h = lane(
      () => [
        chat("zed", [["z1", NOW - HOUR, "who is this?"]]),
        chat("ana", [["a1", NOW - HOUR, "are you there?"]]),
      ],
      { gate: true }
    );
    await h.connect();
    // Ana is approved and passes (no workspace here, so she gets the app's notice); Zed gets nothing.
    expect(h.sent.map(([to]) => to)).toEqual(["ana"]);
  });

  it("catches up what came in while the computer slept, though the lane never went down", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 30_000, ids: [] } };
    let asleepAt = 0;
    const h = lane((since) =>
      since <= asleepAt
        ? [chat("ana", [["s1", asleepAt + HOUR, "you up?"]])]
        : []
    );
    await h.connect();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(h.turns).toEqual([]);
    // Asleep for two hours: no timer runs, then the first late heartbeat.
    asleepAt = Date.now();
    vi.setSystemTime(asleepAt + 2 * HOUR);
    // The late heartbeat, then a moment for the page to sync, then the read.
    await vi.advanceTimersByTimeAsync(60_000 + 30_000 + 50);
    expect(h.reads.at(-1)).toBeLessThanOrEqual(asleepAt);
    expect(h.turns.map((turn) => turn.text)).toEqual([
      expect.stringMatching(/^\[late\] .+\n\nyou up\?$/),
    ]);
  });

  it("never lets chats it would not answer crowd out the user's own chat", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 3 * HOUR, ids: [] } };
    // Ten busy groups nobody allowed, all newer than the user's note to self.
    const groups = Array.from({ length: 10 }, (_, i) =>
      chat(
        `group${i}`,
        [[`g${i}`, NOW - 10_000 + i, `chatter ${i}`]],
        false,
        "group"
      )
    );
    const h = lane(() => [
      ...groups,
      chat("me", [["s1", NOW - 2 * HOUR, "remind me at 5"]]),
    ]);
    await h.connect();
    expect(h.turns.map((turn) => turn.chatId)).toEqual(["me"]);
    // Nothing that would not be answered is reported as missed either.
    expect(h.sent).toEqual([]);
  });

  it("keeps the mark at what a read saw, so a store that syncs late is still caught up", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 30_000, ids: [] } };
    let synced = false;
    let asleepAt = 0;
    const h = lane(() =>
      synced ? [chat("ana", [["s1", asleepAt + HOUR, "you up?"]])] : []
    );
    await h.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    asleepAt = Date.now();
    vi.setSystemTime(asleepAt + 2 * HOUR);
    // Woken: the late heartbeat, the settle, and a read of a store not yet synced.
    await vi.advanceTimersByTimeAsync(60_000 + 30_000 + 50);
    expect(h.turns).toEqual([]);
    expect(
      (stored.seen as { whatsapp: { seenUntil: number } }).whatsapp.seenUntil
    ).toBeLessThanOrEqual(asleepAt);
    // The store syncs; the lane relinks and reads again from the same mark.
    synced = true;
    h.disconnect();
    await h.connect();
    expect(h.turns.map((turn) => turn.chatId)).toEqual(["ana"]);
  });

  it("answers at most 10 chats and tells the user once about the rest and the too-old", async () => {
    stored.seen = { whatsapp: { seenUntil: NOW - 9 * HOUR, ids: [] } };
    const recent = Array.from({ length: 12 }, (_, i) =>
      chat(`c${i}`, [[`r${i}`, NOW - HOUR, `msg ${i}`]])
    );
    for (let i = 0; i < 12; i += 1) stored.approved.add(`c${i}`);
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
