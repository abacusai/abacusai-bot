/**
 * A connect link lives as long as the server minted it for. That one expiry
 * decides when the watch gives up, what the model is told to pass on, and
 * when the Connect card turns into "Get a new link". The time left is read on
 * the server's own clock, so a skewed local clock moves neither. A link that
 * lives for days is asked about less and less, and not at all after a day.
 */
import type {
  ConnectorRequest,
  ConnectorStatuses,
  IpcEvent,
} from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectorGate } from "../agent-tools/connector-gate";
import { McpAgentToolsServer } from "../mcp/mcp-agent-tools-server";
import { linkLifetime } from "../mcp/tools/connect-outcome";
import { linkExpiresAt } from "../providers/abacus-connector-service";
import { ConnectWatcher, nextCheckAt } from "./connect-watcher";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LIFETIME_MS = 20 * MIN;
/** How long past its expiry a link is still watched for a late sign-in. */
const GRACE_MS = 5 * MIN;

let statuses: ConnectorStatuses;
let events: IpcEvent[];
let gate: ConnectorGate;
let watcher: ConnectWatcher;
let minted: number;
const mint = vi.fn();
const linkStatus = vi.fn();

const server = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["connectors"]),
    workspacePath: () => null,
    conversationKeyForSession: (sessionId) =>
      sessionConversationKey("ws-1", sessionId),
    connectors: {
      list: async () => statuses,
      link: mint,
      show: (input) => gate.show(input),
      watch: (input) => watcher.watch(input),
    },
  });

const ask = async (service: string, session: string): Promise<string> => {
  const result = await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("connect_connector", { service }, session);
  return result.content.map((part) => part.text ?? "").join("\n");
};

const cards = (): ConnectorRequest[] => gate.listPending();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 9, 13, 0, 0));
  minted = 0;
  linkStatus.mockReset();
  linkStatus.mockResolvedValue({
    completed: false,
    connected: [],
    notGranted: [],
  });
  mint.mockReset();
  mint.mockImplementation(async (connectorId: string) => {
    minted += 1;
    return {
      url: `https://apps.example/connect?r=req-${minted}`,
      connectorIds: [connectorId],
      requestId: `req-${minted}`,
      expiresAt: Date.now() + LIFETIME_MS,
    };
  });
  statuses = {
    "abacus-slack": { state: "available" },
    "messaging-whatsapp": { state: "available" },
  };
  events = [];
  gate = new ConnectorGate((event) => events.push(event));
  watcher = new ConnectWatcher({
    list: async () => statuses,
    linkStatus,
    connected: () => {},
    expired: (ids, linked) => gate.expire(ids, linked, Date.now()),
  });
});

afterEach(() => {
  watcher.stop();
  vi.useRealTimers();
});

describe("the server's expiry", () => {
  it("is what the model is told to pass on, and what the card counts down to", async () => {
    const text = await ask("slack", "session-1");

    expect(text).toContain("https://apps.example/connect?r=req-1");
    expect(text).toContain(
      "This link works until 13:20 (about 20 min from now)"
    );
    expect(text).toContain("say in the user's language how long it works");
    expect(cards()).toMatchObject([
      { connectorId: "abacus-slack", expiresAt: Date.now() + LIFETIME_MS },
    ]);
  });

  it("drives the watch's give-up time, a grace period past it, not a fixed 30 minutes", async () => {
    await ask("slack", "session-1");

    await vi.advanceTimersByTimeAsync(LIFETIME_MS + GRACE_MS - 10_000);
    expect(cards()[0]?.expired).toBeUndefined();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(cards()[0]?.expired).toBe(true);
  });

  it("says nothing of a lifetime when the server gave none, and gives up at 30 minutes", async () => {
    mint.mockImplementationOnce(async (connectorId: string) => ({
      url: "https://apps.example/connect?r=plain",
      connectorIds: [connectorId],
      requestId: "plain",
    }));
    const text = await ask("slack", "session-1");

    expect(text).not.toContain("This link works until");
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(cards()[0]?.expired).toBeUndefined();
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(cards()[0]?.expired).toBe(true);
  });
});

describe("an expired card", () => {
  it("is kept and shown again marked expired, not cleared", async () => {
    await ask("slack", "session-1");
    const [card] = cards();

    await vi.advanceTimersByTimeAsync(LIFETIME_MS + GRACE_MS + 10_000);

    expect(cards()).toEqual([{ ...card, expired: true }]);
    expect(events.map((event) => event.type)).not.toContain(
      "connector-cleared"
    );
    expect(events.at(-1)).toMatchObject({
      type: "connector-request",
      request: { requestId: card!.requestId, expired: true },
    });
  });

  it("counts down again from the fresh link its button got", async () => {
    await ask("slack", "session-1");
    await vi.advanceTimersByTimeAsync(LIFETIME_MS + GRACE_MS + 10_000);

    const fresh = Date.now() + LIFETIME_MS;
    gate.renew("abacus-slack", fresh);

    expect(cards()[0]?.expired).toBeUndefined();
    expect(cards()[0]?.expiresAt).toBe(fresh);
  });

  it("goes as before when no link stood behind it", async () => {
    await ask("whatsapp", "session-1");
    expect(cards()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(31 * MIN);

    expect(cards()).toEqual([]);
  });
});

describe("the time left, from the mint", () => {
  const received = Date.UTC(2026, 10, 9, 13, 0, 0);
  const seconds = (ms: number) => Math.floor(ms / 1000);

  it("takes a relative lifetime first", () => {
    expect(
      linkExpiresAt({ expiresIn: 1200, expiresAt: 1 }, undefined, received)
    ).toBe(received + 20 * MIN);
  });

  it("counts from receipt by the server's clock when it is behind this one", () => {
    const server = received - 8 * MIN;
    expect(
      linkExpiresAt({ expiresAt: seconds(server + 30 * MIN) }, server, received)
    ).toBe(received + 30 * MIN);
  });

  it("counts from receipt by the server's clock when it is ahead of this one", () => {
    const server = received + 8 * MIN;
    expect(
      linkExpiresAt(
        { expires_at: seconds(server + 30 * MIN) },
        server,
        received
      )
    ).toBe(received + 30 * MIN);
  });

  it("prefers a server time in the payload to the Date header", () => {
    const issued = received - 3 * MIN;
    expect(
      linkExpiresAt(
        { expiresAt: seconds(issued + 30 * MIN), issuedAt: seconds(issued) },
        received + 60 * MIN,
        received
      )
    ).toBe(received + 30 * MIN);
  });

  it("falls back to the local clock as it stands, with no floor, when the server gave no time", () => {
    expect(
      linkExpiresAt(
        { expiresAt: seconds(received + 6 * MIN) },
        undefined,
        received
      )
    ).toBe(received + 6 * MIN);
  });

  it("has no expiry when the server gave none", () => {
    expect(linkExpiresAt({}, received, received)).toBeUndefined();
  });
});

describe("the time a link works, as the model is told it", () => {
  const now = new Date(2026, 10, 9, 13, 0, 0).getTime();

  it.each([
    [20 * MIN, { until: "13:20", left: "20 min" }],
    [30 * 1000, { until: "13:00", left: "1 min" }],
    [2 * HOUR + 5 * MIN, { until: "15:05", left: "2 h 5 min" }],
    [HOUR, { until: "14:00", left: "1 h" }],
    [11 * HOUR, { until: "00:00 on Tue 2026-11-10", left: "11 h" }],
    [
      DAY + 3 * HOUR + 40 * MIN,
      { until: "16:40 on Tue 2026-11-10", left: "1 day 3 h" },
    ],
    [7 * DAY, { until: "13:00 on Mon 2026-11-16", left: "7 days" }],
  ])("%i ms left reads %o", (leftMs, expected) => {
    expect(linkLifetime(now + leftMs, now)).toEqual(expected);
  });

  it("a week-long link is passed on in days, with its date", async () => {
    mint.mockImplementationOnce(async (connectorId: string) => ({
      url: "https://apps.example/connect?r=week",
      connectorIds: [connectorId],
      requestId: "week",
      expiresAt: Date.now() + 7 * DAY,
    }));
    const text = await ask("slack", "session-1");

    expect(text).toContain(
      "This link works until 13:00 on Mon 2026-11-16 (about 7 days from now)"
    );
    expect(text).not.toContain("10080");
  });
});

describe("asking about a long-lived link", () => {
  const week = async (): Promise<void> => {
    mint.mockImplementationOnce(async (connectorId: string) => ({
      url: "https://apps.example/connect?r=week",
      connectorIds: [connectorId],
      requestId: "week",
      expiresAt: Date.now() + 7 * DAY,
    }));
    await ask("slack", "session-1");
  };

  it("checks every 5 s for half an hour, every 3 min to a day, then stops", async () => {
    await week();

    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(linkStatus).toHaveBeenCalledTimes(360);

    linkStatus.mockClear();
    await vi.advanceTimersByTimeAsync(DAY - 30 * MIN);
    expect(linkStatus).toHaveBeenCalledTimes((23.5 * 60) / 3);

    linkStatus.mockClear();
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(linkStatus).not.toHaveBeenCalled();
    // The card stays, counting down to the link's own expiry.
    expect(cards()).toMatchObject([
      { connectorId: "abacus-slack", expiresAt: expect.any(Number) },
    ]);
    expect(cards()[0]?.expired).toBeUndefined();
  });

  it("still reports a link completed in the slow hours, within one slow tick", async () => {
    const connected = vi.fn();
    watcher.stop();
    watcher = new ConnectWatcher({
      list: async () => statuses,
      linkStatus,
      connected,
      expired: () => {},
    });
    await week();

    await vi.advanceTimersByTimeAsync(5 * HOUR);
    linkStatus.mockResolvedValue({
      completed: true,
      connected: ["abacus-slack"],
      notGranted: [],
    });
    await vi.advanceTimersByTimeAsync(3 * MIN);

    expect(connected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ connectorIds: ["abacus-slack"] })
    );
  });

  it("a fresh offer is checked at once, not after the slow tick another one is on", async () => {
    await week();
    await vi.advanceTimersByTimeAsync(HOUR);
    linkStatus.mockClear();

    watcher.watch({
      connectorIds: ["abacus-notion"],
      sessionId: "session-2",
      requestId: "other",
      expiresAt: Date.now() + 7 * DAY,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(linkStatus).toHaveBeenCalledWith("other");
  });

  it.each([
    [0, 5_000],
    [29 * MIN, 29 * MIN + 5_000],
    [30 * MIN, 33 * MIN],
    [23 * HOUR, 23 * HOUR + 3 * MIN],
    [DAY, null],
  ])("an offer %i ms old is next checked at %o", (age, next) => {
    expect(nextCheckAt(0, age)).toBe(next);
  });
});
