/**
 * A connect link lives as long as the server minted it for. That one expiry
 * decides when the watch gives up, what the model is told to pass on, and
 * when the Connect card turns into "Get a new link". The time left is read on
 * the server's own clock, so a skewed local clock moves neither.
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
import { linkExpiresAt } from "../providers/abacus-connector-service";
import { ConnectWatcher } from "./connect-watcher";

const MIN = 60_000;
const LIFETIME_MS = 20 * MIN;
/** How long past its expiry a link is still watched for a late sign-in. */
const GRACE_MS = 5 * MIN;

let statuses: ConnectorStatuses;
let events: IpcEvent[];
let gate: ConnectorGate;
let watcher: ConnectWatcher;
let minted: number;
const mint = vi.fn();

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
    linkStatus: async () => ({
      completed: false,
      connected: [],
      notGranted: [],
    }),
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
