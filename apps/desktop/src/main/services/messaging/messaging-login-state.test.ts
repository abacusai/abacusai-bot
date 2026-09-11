/**
 * `needs_login` is a healthy connector waiting on a human, and the gateway
 * treats it that way.
 *
 * The old shape — "waiting for a QR scan" reported as `error` — combined with
 * syncConnectors evicting every errored connector on every sync to produce the
 * ghost pop-ups: connect WhatsApp, close the dialog without scanning, then
 * connect Discord, and WhatsApp's login window came back. The restart reset
 * the connector's one-shot reveal guard, so every sync walked through it.
 *
 * Two invariants pinned here: a connector in `needs_login` is never evicted by
 * a sync, and a connector in `error` is restarted on a growing backoff rather
 * than on every sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

/** What each stub connector's login probe will report, when asked. */
const probeVerdicts = new Map<MessagingPlatformId, string>();

type Callbacks = {
  onState: (state: string, error?: string) => void;
  onMessage: (message: unknown) => void;
  onLog: (line: string) => void;
};

/** Builds a gateway whose connectors are stubs that hand their callbacks back. */
const service = (): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  captured: Callbacks[];
} => {
  const captured: Callbacks[] = [];

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  const build = (
    gateway as unknown as {
      buildConnector: (id: MessagingPlatformId) => unknown;
    }
  ).buildConnector.bind(gateway);
  (
    gateway as unknown as {
      buildConnector: (id: MessagingPlatformId) => unknown;
    }
  ).buildConnector = (id: MessagingPlatformId) => {
    // Reuse the real callback wiring — the state handling is what is under
    // test, and rebuilding it here would test the test.
    const real = build(id) as { callbacks?: Callbacks };
    const callbacks = (real as unknown as { callbacks: Callbacks }).callbacks;
    captured.push(callbacks);
    return {
      id,
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      // The probe is the page's verdict this second: whatever the stub was
      // told to answer, reported the way a real connector reports it.
      probeLive: async () => {
        const verdict = probeVerdicts.get(id);
        if (verdict != null) callbacks.onState(verdict);
        return verdict === "connected";
      },
      callbacks,
    };
  };

  return { gateway, captured };
};

const platformState = (
  gateway: InstanceType<typeof MessagingGatewayService>
): string | undefined =>
  gateway.getSnapshot().platforms.find((platform) => platform.id === "discord")
    ?.state;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a connector waiting on a login", () => {
  it("reports needs_login through to the snapshot", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();

    captured[0]!.onState("needs_login", "Scan the QR to connect.");

    expect(platformState(gateway)).toBe("needs_login");
    const discord = gateway
      .getSnapshot()
      .platforms.find((platform) => platform.id === "discord");
    expect(discord?.errorMessage).toBe("Scan the QR to connect.");
  });

  it("is never evicted by a sync", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("needs_login", "Scan the QR to connect.");

    // Touching any other platform triggers exactly this call.
    await gateway.syncConnectors();
    await gateway.syncConnectors();

    // Still the original connector: no eviction, so no restart, so no
    // re-revealed login window.
    expect(captured).toHaveLength(1);
    expect(platformState(gateway)).toBe("needs_login");
  });
});

describe("a connector that failed", () => {
  it("is restarted on a backoff, not on every sync", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("error", "boom");

    // First sync after the failure restarts it (the backoff ladder starts
    // counting from here)...
    await gateway.syncConnectors();
    expect(captured).toHaveLength(2);

    // ...but a failure straight after is NOT restarted by the next sync.
    captured[1]!.onState("error", "boom again");
    await gateway.syncConnectors();
    expect(captured).toHaveLength(2);

    // Once the delay has passed, the next sync tries again. Attempt 1's
    // delay is at most 2s (backoffDelayMs is jittered below its base).
    vi.advanceTimersByTime(2_001);
    await gateway.syncConnectors();
    expect(captured).toHaveLength(3);
  });

  it("starts the ladder over after a successful connect", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("error", "boom");
    await gateway.syncConnectors();
    expect(captured).toHaveLength(2);

    // Recovery clears the backoff...
    captured[1]!.onState("connected");
    captured[1]!.onState("error", "died later");

    // ...so a fresh failure is restarted by the very next sync.
    await gateway.syncConnectors();
    expect(captured).toHaveLength(3);
  });
});

describe("asking the platforms before saying what is connected", () => {
  it("drops a platform whose page says it is logged out, however the last poll read", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("connected");
    expect(gateway.livePlatforms()).toEqual(["discord"]);

    probeVerdicts.set("discord", "needs_login");
    // Real timers: the probe races a timeout, and a faked clock never fires it.
    vi.useRealTimers();
    const live = await gateway.probeLivePlatforms();

    expect(live).toEqual([]);
    expect(platformState(gateway)).toBe("needs_login");
    probeVerdicts.clear();
  });
});
