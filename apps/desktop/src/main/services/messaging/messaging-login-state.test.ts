import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * `needs_login` is a healthy connector waiting on a human, and the gateway
 * treats it that way.
 *
 * The old shape ("waiting for a QR scan" reported as `error`) combined with
 * syncConnectors evicting every errored connector on every sync to produce the
 * ghost pop-ups: connect WhatsApp, close the dialog without scanning, then
 * connect Discord, and WhatsApp's login window came back. The restart reset
 * the connector's one-shot reveal guard, so every sync walked through it.
 *
 * Two invariants pinned here: a connector in `needs_login` is never evicted by
 * a sync, and a connector in `error` is restarted by a sync at most once per
 * 30 s (a retryable one is also retried by the gateway's LaneSupervisor).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Whether the stored link is recorded as lost. */
const stored = vi.hoisted(() => ({ linkLost: false }));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readPlatformLinkLost: () => stored.linkLost,
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
}));

// No OS events to watch here: hints have their own test (lane-supervisor.test.ts).
vi.mock("./page-boot-watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./page-boot-watch")>()),
  watchLaneHints: () => () => {},
}));

const { MessagingGatewayService, RELEASED_LOGIN_MS } =
  await import("./messaging-gateway-service");

/** What each stub connector's login probe will report, when asked. */
const probeVerdicts = new Map<MessagingPlatformId, string>();

type Callbacks = {
  onState: (state: string, error?: string) => void;
  onMessage: (message: unknown) => void;
  onLog: (line: string) => void;
};

/** Builds a gateway whose connectors are stubs that hand their callbacks back. */
const service = (
  notifyUser?: (platform: string, title: string, body: string) => void
): {
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
    notifyUser,
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
    // Reuse the real callback wiring; the state handling is what is under
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

describe("a lost link", () => {
  afterEach(() => {
    stored.linkLost = false;
  });

  it("is told outside the chats, once a launch, and again if it is lost after coming back", async () => {
    const told: string[] = [];
    const { gateway, captured } = service((_platform, title) =>
      told.push(title)
    );
    await gateway.syncConnectors();
    const settled = async (count: number) => {
      await vi.waitFor(() => expect(told).toHaveLength(count));
    };

    // Waiting on a first login is nothing to announce.
    captured[0]!.onState("needs_login", "Scan to connect.");
    await vi.advanceTimersByTimeAsync(0);
    expect(told).toEqual([]);

    stored.linkLost = true;
    captured[0]!.onState("needs_login", "No longer linked.");
    await settled(1);
    expect(told[0]).toContain("Discord");
    captured[0]!.onState("needs_login", "No longer linked, still.");
    await vi.advanceTimersByTimeAsync(0);
    expect(told).toHaveLength(1);

    captured[0]!.onState("connected");
    captured[0]!.onState("needs_login", "No longer linked.");
    await settled(2);
  });
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
  it("is restarted by a sync (the user's Connect), at most once per 30 s", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("error", "boom");

    await gateway.syncConnectors();
    await vi.advanceTimersByTimeAsync(0);
    expect(captured).toHaveLength(2);

    // A failure straight after is NOT restarted by the next sync...
    captured[1]!.onState("error", "boom again");
    await gateway.syncConnectors();
    await vi.advanceTimersByTimeAsync(0);
    expect(captured).toHaveLength(2);

    // ...but is once 30 s have passed.
    await vi.advanceTimersByTimeAsync(30_001);
    await gateway.syncConnectors();
    await vi.advanceTimersByTimeAsync(0);
    expect(captured).toHaveLength(3);
  });

  it("comes back by itself when it says it may be retried, with no sync", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    (
      captured[0]!.onState as (
        state: string,
        error?: string,
        failure?: unknown
      ) => void
    )("error", "could not be reached", { retry: "auto" });

    await vi.advanceTimersByTimeAsync(16_000);
    expect(captured).toHaveLength(2);
    captured[1]!.onState("connected");
    expect(platformState(gateway)).toBe("connected");
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

describe("a login whose connect dialog closed unlinked", () => {
  // The phone is ahead of the app: people close the dialog on the phone's
  // "linked", a moment before the connector says so.
  const released = async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("needs_login", "Scan the QR to connect.");
    const off = vi
      .spyOn(gateway, "updatePlatform")
      .mockResolvedValue(gateway.getSnapshot());
    gateway.releaseLogin("discord");
    return { gateway, captured, off };
  };

  it("is kept when the scan lands after the dialog closed", async () => {
    const { gateway, captured, off } = await released();
    captured[0]!.onState("connected");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(off).not.toHaveBeenCalled();
    expect(platformState(gateway)).toBe("connected");
  });

  it("is turned off, with its shared-bot lane, when none lands in time", async () => {
    const { off } = await released();
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS - 1);
    expect(off).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(off.mock.calls.map(([request]) => request)).toEqual([
      { platformId: "abacus_discord", enabled: false },
      { platformId: "discord", enabled: false },
    ]);
  });

  it("is not turned off while its page is still loading", async () => {
    // A stored link signing back in (or a slow first load) shows no login yet.
    const { gateway, captured, off } = await released();
    captured[0]!.onState("connecting");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS * 3);
    expect(off).not.toHaveBeenCalled();

    captured[0]!.onState("connected");
    expect(platformState(gateway)).toBe("connected");
  });

  it("is turned off once a page that was loading lands on its login", async () => {
    const { captured, off } = await released();
    captured[0]!.onState("connecting");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    captured[0]!.onState("needs_login", "Scan the QR to connect.");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(off).toHaveBeenCalledWith({
      platformId: "discord",
      enabled: false,
    });
  });

  it("is not abandoned once its login is shown again", async () => {
    const { gateway, off } = await released();
    gateway.showMessagingLogin("discord");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(off).not.toHaveBeenCalled();
  });

  it("leaves a connected platform alone", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("connected");
    const off = vi.spyOn(gateway, "updatePlatform");
    gateway.releaseLogin("discord");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(off).not.toHaveBeenCalled();
  });
});
