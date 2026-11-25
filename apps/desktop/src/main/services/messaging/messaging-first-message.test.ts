import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * A shared bot's own chat that refuses until the user writes to the bot
 * there: what it owes is held (never given up on), the user is told once
 * what to do, and it all goes when they write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({
  outbox: null as { pending: unknown[]; done: string[] } | null,
  firstMessage: new Set<string>(),
  lanes: ["abacus_discord"] as string[],
}));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => [],
  writeStoredMessageLog: () => {},
  readStoredOutbox: () => stored.outbox,
  writeStoredOutbox: (state: { pending: unknown[]; done: string[] }) => {
    stored.outbox = structuredClone(state);
  },
  readPlatformFirstMessageNeeded: (id: string) => stored.firstMessage.has(id),
  savePlatformFirstMessageNeeded: (id: string, needed: boolean) => {
    if (needed) stored.firstMessage.add(id);
    else stored.firstMessage.delete(id);
  },
  readPlatformLinkLost: () => false,
  readPlatformAppStopped: () => null,
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => stored.lanes.includes(id),
  isPlatformConfigured: (id: MessagingPlatformId) => stored.lanes.includes(id),
}));
// No OS events to watch here: hints have their own test (lane-supervisor.test.ts).
vi.mock("./page-boot-watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./page-boot-watch")>()),
  watchLaneHints: () => () => {},
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { FirstMessageNeededError } = await import("./connector");
const { StatusBoard, STATUS_BATCH_MS } = await import("../status/status-board");
const { channelWords } = await import("./channel-words");
const english = await channelWords("en-US");

type Callbacks = {
  onState: (state: string, error?: string) => void;
  onMessage: (message: unknown) => void;
};

/** Discord's server-side answer while the user never wrote to the bot. */
const REFUSAL =
  "Discord will not deliver DMs from the agent until you message it on Discord first or share a server with it";

const service = async () => {
  const notices: string[] = [];
  const board = new StatusBoard({
    file: () => null,
    words: async () => english,
    notify: (notice) => notices.push(`${notice.title} | ${notice.body}`),
  });
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    status: board,
  } as never);
  const discord = { closed: true, sent: [] as string[] };
  const telegram = { sent: [] as string[] };
  const lanes = new Map<string, Callbacks>();
  const internals = gateway as unknown as {
    buildConnector: (id: MessagingPlatformId) => unknown;
  };
  const build = internals.buildConnector.bind(gateway);
  internals.buildConnector = (id: MessagingPlatformId) => {
    // The real callback wiring; only the wire is a stub.
    const { callbacks } = build(id) as unknown as { callbacks: Callbacks };
    lanes.set(id, callbacks);
    return {
      id,
      start: async () => {},
      stop: async () => {},
      selfChatId: () => "me",
      sendText: async (_chatId: string, text: string) => {
        if (id === "abacus_telegram") return void telegram.sent.push(text);
        if (discord.closed) throw new FirstMessageNeededError(REFUSAL);
        discord.sent.push(text);
      },
    };
  };
  await gateway.syncConnectors();
  for (const callbacks of lanes.values()) callbacks.onState("connected");
  const userWrites = (lane: MessagingPlatformId) => {
    discord.closed = false;
    lanes.get(lane)!.onMessage({
      userId: "me",
      userName: null,
      chatId: "me",
      text: "hi",
    });
  };
  return { gateway, board, notices, discord, telegram, userWrites };
};

beforeEach(() => {
  vi.useFakeTimers();
  stored.outbox = null;
  stored.firstMessage.clear();
  stored.lanes = ["abacus_discord"];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Discord refusing the user's own chat until they write to the bot", () => {
  it("holds a routine report past every retry, tells the user once, and sends it when they write", async () => {
    const { gateway, board, notices, discord, userWrites } = await service();
    const report = {
      id: "routine-report:job@1:abacus_discord",
      text: "Report",
    };
    expect(await gateway.sendToOwnChat("abacus_discord", report)).toBe(
      "queued"
    );
    expect(
      await gateway.sendToOwnChat("abacus_discord", {
        id: "routine-report:job@2:abacus_discord",
        text: "Next report",
      })
    ).toBe("queued");
    // Past both retry waits: still owed, never given up on.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(gateway.ownChatSendStatus(report.id).status).toBe("queued");
    expect(gateway.awaitsFirstMessage("abacus_discord")).toBe(true);
    expect(board.get("lane:abacus_discord")).toMatchObject({
      state: "stopped-needs-user",
      reason: "first-message",
    });
    expect(notices).toEqual([
      "Say hi to Abacus AI on Discord | Discord only lets Abacus AI message you after you message it once. Open its chat and say hi: what's waiting for you there arrives right after.",
    ]);

    userWrites("abacus_discord");
    await vi.advanceTimersByTimeAsync(STATUS_BATCH_MS);
    // The bot's answer to the "hi" itself goes too; the held reports go once each.
    expect(discord.sent.filter((text) => /report/i.test(text))).toEqual([
      "Report",
      "Next report",
    ]);
    expect(gateway.ownChatSendStatus(report.id).status).toBe("sent");
    expect(gateway.awaitsFirstMessage("abacus_discord")).toBe(false);
    expect(board.get("lane:abacus_discord")).toBeNull();
  });

  it("is still shown after a restart, from what was kept", async () => {
    stored.firstMessage.add("abacus_discord");
    const { board, notices } = await service();
    expect(board.get("lane:abacus_discord")).toMatchObject({
      state: "stopped-needs-user",
      reason: "first-message",
    });
    await vi.advanceTimersByTimeAsync(STATUS_BATCH_MS);
    expect(notices).toHaveLength(1);
  });

  it("lets the agent's message to the user go through another app that is up, never Discord", async () => {
    stored.lanes = ["abacus_discord", "abacus_telegram"];
    const { gateway, discord, telegram } = await service();
    const went = await gateway.sendToChat("abacus_discord", "me", "Hello");
    expect(went).toMatchObject({
      platform: "abacus_telegram",
      queued: false,
      downApp: "discord",
    });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]).toContain("Hello");
    // A message owed to Telegram while it is down is not carried by the closed Discord.
    expect(discord.sent).toEqual([]);
  });

  it("tells the agent its message is queued for the user's first message, not delivered", async () => {
    const { gateway } = await service();
    const went = await gateway.sendToChat("abacus_discord", "me", "Hello");
    expect(went).toMatchObject({
      queued: true,
      firstMessageApp: "Discord",
    });
  });
});
