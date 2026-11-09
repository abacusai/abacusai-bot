import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * The shared Abacus bot lane comes back by itself after a failed status call.
 *
 * One status call that was aborted (a timeout, a dropped connection) put the
 * shared Telegram lane in `error` with nothing linked. Its poll then idled
 * forever, since it re-read status only after inbox failures, which count only
 * while linked; and the error said nothing about being retryable, so nothing
 * else retried it. The lane stayed dead until a relaunch, and a check-in sent
 * to the user's own chat was lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readPlatformLinkLost: () => false,
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => id === "abacus_telegram",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "abacus_telegram",
}));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));
// No OS events to watch here: hints have their own test (lane-supervisor.test.ts).
vi.mock("./page-boot-watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./page-boot-watch")>()),
  watchLaneHints: () => () => {},
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

/** The channels endpoint: each status call takes the next scripted answer. */
const server = {
  status: [] as Array<"abort" | "refused" | "linked">,
  calls: [] as string[],
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.useFakeTimers();
  server.status = [];
  server.calls = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action: string };
    server.calls.push(body.action);
    if (body.action === "inbox")
      return new Promise<Response>(() => {
        // Long poll: holds while the test runs.
      });
    const answer = server.status.shift() ?? "linked";
    if (answer === "abort")
      throw new DOMException("This operation was aborted", "AbortError");
    if (answer === "refused") return json(401, { error: "Invalid API key" });
    return json(200, {
      available: ["telegram"],
      channels: { telegram: { status: "linked", display_name: "Me" } },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.useRealTimers());

const gateway = () =>
  new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

const laneState = (g: ReturnType<typeof gateway>) =>
  g.getSnapshot().platforms.find((p) => p.id === "abacus_telegram")?.state;

describe("the shared Telegram lane", () => {
  it("comes back by itself after an aborted status call", async () => {
    server.status = ["abort"];
    const g = gateway();
    await g.syncConnectors();
    await vi.advanceTimersByTimeAsync(0);
    expect(laneState(g)).toBe("error");

    // Within the supervisor's first step (10 s ±50%): a fresh lane, linked.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(server.calls.filter((c) => c === "status")).toHaveLength(2);
    expect(laneState(g)).toBe("connected");
    expect(server.calls).toContain("inbox");
    await g.dispose();
  });

  it("waits for the user when the server refuses the credential", async () => {
    server.status = ["refused"];
    const g = gateway();
    await g.syncConnectors();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(server.calls.filter((c) => c === "status")).toHaveLength(1);
    expect(laneState(g)).toBe("error");
    await g.dispose();
  });
});
