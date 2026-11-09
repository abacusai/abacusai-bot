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

/** Whether the stored link is recorded as lost, and what the app stopped. */
const stored = vi.hoisted(() => ({
  linkLost: false,
  appStopped: {} as Record<string, "login-not-finished" | null>,
  enabled: [] as string[],
}));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readPlatformLinkLost: () => stored.linkLost,
  readPlatformAppStopped: (id: string) => stored.appStopped[id] ?? null,
  savePlatformAppStopped: (id: string, reason: "login-not-finished" | null) => {
    stored.appStopped[id] = reason;
  },
  // The user's own switch: the app must never write it.
  setPlatformEnabled: (id: string, enabled: boolean) => {
    stored.enabled.push(`${id}:${String(enabled)}`);
  },
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) =>
    id === "discord" || id === "abacus_discord",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
}));

// No OS events to watch here: hints have their own test (lane-supervisor.test.ts).
vi.mock("./page-boot-watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./page-boot-watch")>()),
  watchLaneHints: () => () => {},
}));

const { MessagingGatewayService, RELEASED_LOGIN_MS } =
  await import("./messaging-gateway-service");
const { StatusBoard, STATUS_BATCH_MS, STATUS_MERGE_MS, LANE_FLAP_COOLDOWN_MS } =
  await import("../status/status-board");
const { channelWords } = await import("./channel-words");
const english = await channelWords("en-US");

/** Holds stub connectors' stop() open while a test needs it to be slow. */
const stopGate = {
  held: null as Promise<void> | null,
  wait: (): Promise<void> => stopGate.held ?? Promise.resolve(),
};

/** What each stub connector's login probe will report, when asked. */
const probeVerdicts = new Map<MessagingPlatformId, string>();

type Callbacks = {
  onState: (state: string, error?: string) => void;
  onMessage: (message: unknown) => void;
  onLog: (line: string) => void;
};

/** Builds a gateway whose connectors are stubs that hand their callbacks back. */
const service = (
  notified?: (title: string) => void
): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  captured: Callbacks[];
  board: InstanceType<typeof StatusBoard>;
} => {
  const captured: Callbacks[] = [];
  // The real status board, in memory: the gateway reports, the board tells.
  const board = new StatusBoard({
    file: () => null,
    words: async () => english,
    notify: (notice) => notified?.(notice.title),
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
      stop: () => stopGate.wait(),
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

  return { gateway, captured, board };
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
  stored.appStopped = {};
  stored.enabled = [];
});

describe("a lost link", () => {
  afterEach(() => {
    stored.linkLost = false;
  });

  it("is told outside the chats, once per cooldown, and again if it is lost after coming back", async () => {
    const told: string[] = [];
    const { gateway, captured } = service((title) => told.push(title));
    await gateway.syncConnectors();
    const settled = async (count: number) => {
      await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
      expect(told).toHaveLength(count);
    };

    // Waiting on a first login is nothing to announce.
    captured[0]!.onState("needs_login", "Scan to connect.");
    await vi.advanceTimersByTimeAsync(0);
    expect(told).toEqual([]);

    stored.linkLost = true;
    captured[0]!.onState("needs_login", "No longer linked.");
    await settled(1);
    expect(told[0]).toBe("Discord is disconnected");
    captured[0]!.onState("needs_login", "No longer linked, still.");
    await settled(1);

    // Lost again at once (a flapping link): not told twice in the cooldown.
    captured[0]!.onState("connected");
    captured[0]!.onState("needs_login", "No longer linked.");
    await settled(1);
    // Back, and lost again after the cooldown: told again.
    captured[0]!.onState("connected");
    await vi.advanceTimersByTimeAsync(LANE_FLAP_COOLDOWN_MS);
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

  it("starts nothing once the gateway is disposed mid-restart", async () => {
    // The first retry lands at exactly 10 s.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    let release = (): void => {};
    stopGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    (
      captured[0]!.onState as (
        state: string,
        error?: string,
        failure?: unknown
      ) => void
    )("error", "could not be reached", { retry: "auto" });
    // The supervisor's restart is stopping the old lane when the app quits.
    await vi.advanceTimersByTimeAsync(10_100);
    const disposed = gateway.dispose();
    release();
    stopGate.held = null;
    await vi.advanceTimersByTimeAsync(10_000);
    await disposed;
    expect(captured).toHaveLength(1);
    vi.restoreAllMocks();
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

describe("a link lost on an older build (the backfilled linkLost flag)", () => {
  afterEach(() => {
    stored.linkLost = false;
  });

  it("is told at launch, before its connector has said anything", async () => {
    const told: string[] = [];
    const { gateway, board } = service((title) => told.push(title));
    stored.linkLost = true;
    board.reconcile(() => gateway.reportLaneStates());
    expect(board.get("lane:discord")).toMatchObject({
      state: "stopped-needs-user",
      reason: "link-lost",
    });
    await vi.advanceTimersByTimeAsync(STATUS_BATCH_MS);
    expect(told).toEqual(["Discord is disconnected"]);
  });
});

describe("a login whose connect dialog closed unlinked", () => {
  // The phone is ahead of the app: people close the dialog on the phone's
  // "linked", a moment before the connector says so.
  const released = async (notified?: (title: string) => void) => {
    const { gateway, captured, board } = service(notified);
    await gateway.syncConnectors();
    captured[0]!.onState("needs_login", "Scan the QR to connect.");
    gateway.releaseLogin("discord");
    return { gateway, captured, board };
  };
  const stopped = () => stored.appStopped.discord ?? null;

  it("is kept when the scan lands after the dialog closed", async () => {
    const { gateway, captured } = await released();
    captured[0]!.onState("connected");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(stopped()).toBeNull();
    expect(platformState(gateway)).toBe("connected");
  });

  it("is stopped by the app, with its shared-bot lane, never by the user's switch", async () => {
    const told: string[] = [];
    const { gateway, board } = await released((title) => told.push(title));
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS - 1);
    expect(stopped()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(stored.appStopped).toEqual({
      abacus_discord: "login-not-finished",
      discord: "login-not-finished",
    });
    // The saved on/off stays the user's alone.
    expect(stored.enabled).toEqual([]);
    // Still the user's lane: routines skip and make up through it.
    expect(gateway.unlinkedPlatforms()).toContain("discord");
    expect(board.get("lane:discord")).toMatchObject({
      state: "stopped-needs-user",
      reason: "login-not-finished",
    });
    await vi.advanceTimersByTimeAsync(STATUS_BATCH_MS);
    expect(told).toContain("Discord isn't connected");
  });

  it("is not started again by a sync while the app holds it; Connect clears the hold", async () => {
    const { gateway, captured } = await released();
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(stopped()).toBe("login-not-finished");
    const built = captured.length;
    await gateway.syncConnectors();
    expect(captured).toHaveLength(built);
    expect(gateway.runningPlatforms()).not.toContain("discord");
    // Connect: the user's switch, written on, lifts the app's hold.
    stored.appStopped.discord = null;
    await gateway.syncConnectors();
    expect(captured.length).toBeGreaterThan(built);
  });

  it("is not stopped while its page is still loading", async () => {
    // A stored link signing back in (or a slow first load) shows no login yet.
    const { gateway, captured } = await released();
    captured[0]!.onState("connecting");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS * 3);
    expect(stopped()).toBeNull();

    captured[0]!.onState("connected");
    expect(platformState(gateway)).toBe("connected");
  });

  it("is stopped once a page that was loading lands on its login", async () => {
    const { captured } = await released();
    captured[0]!.onState("connecting");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    captured[0]!.onState("needs_login", "Scan the QR to connect.");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(stopped()).toBe("login-not-finished");
  });

  it("is not abandoned once its login is shown again", async () => {
    const { gateway } = await released();
    gateway.showMessagingLogin("discord");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(stopped()).toBeNull();
  });

  it("leaves a connected platform alone", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("connected");
    gateway.releaseLogin("discord");
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
    expect(stopped()).toBeNull();
  });
});
