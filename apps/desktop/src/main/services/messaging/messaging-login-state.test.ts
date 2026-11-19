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
  loginSetup: {} as Record<string, "lane" | "code" | null>,
  enabled: [] as string[],
  /** The lanes switched on, and those configured, in the stored config. */
  on: ["discord", "abacus_discord"] as string[],
  configured: ["discord"] as string[],
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
    stored.on = enabled
      ? [...new Set([...stored.on, id])]
      : stored.on.filter((on) => on !== id);
    // As the real one does: switched by hand, the lane is the user's again.
    stored.appStopped[id] = null;
    stored.loginSetup[id] = null;
  },
  readPlatformLoginSetup: (id: string) => stored.loginSetup[id] ?? null,
  savePlatformLoginSetup: (id: string, setup: "lane" | "code" | null) => {
    stored.loginSetup[id] = setup;
  },
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => stored.on.includes(id),
  isPlatformConfigured: (id: MessagingPlatformId) =>
    stored.configured.includes(id),
}));

// The app window a shared bot's link opens in, for the real connector's tests.
const linkWindow = vi.hoisted(() => ({
  loadURL: () => Promise.resolve(),
  show: () => {},
  focus: () => {},
  close: vi.fn(),
  isDestroyed: () => false,
  on: () => {},
  webContents: {
    on: () => {},
    setWindowOpenHandler: () => {},
    setAudioMuted: () => {},
  },
}));
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  // Discord's link window first shuts its loopback (closeDiscordLoopback).
  session: {
    fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }),
  },
  BrowserWindow: class {
    constructor() {
      return linkWindow;
    }
  },
}));
vi.mock("../../bring-to-front", () => ({ parentWindow: () => null }));

// The shared bot's server, for the tests that run its real connector.
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
  notified?: (title: string) => void,
  /** Run the shared bot lanes' real connectors, against the fake server. */
  realShared = false,
  host: "electron" | "web-host" = "electron"
): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  captured: Callbacks[];
  /** The latest connector's callbacks per lane. */
  lanes: Map<MessagingPlatformId, Callbacks>;
  board: InstanceType<typeof StatusBoard>;
} => {
  const captured: Callbacks[] = [];
  const lanes = new Map<MessagingPlatformId, Callbacks>();
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
    platform: () => host,
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
    lanes.set(id, callbacks);
    if (realShared && id.startsWith("abacus_")) return real;
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

  return { gateway, captured, lanes, board };
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
  stored.loginSetup = {};
  stored.enabled = [];
  stored.on = ["discord", "abacus_discord"];
  stored.configured = ["discord"];
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

  it("is stopped by the app, never by the user's switch", async () => {
    const told: string[] = [];
    const { gateway, board } = await released((title) => told.push(title));
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS - 1);
    expect(stopped()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped()).toBe("login-not-finished");
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

describe("an abandoned personal login next to its chat app's shared-bot lane", () => {
  type Personal = "discord" | "telegram";
  /** The lanes the app holds stopped (a hand switch leaves `null`). */
  const held = () =>
    Object.fromEntries(
      Object.entries(stored.appStopped).filter(([, why]) => why != null)
    );
  const sharedOf = (personal: Personal) => `abacus_${personal}` as const;
  const stateOf = (
    gateway: InstanceType<typeof MessagingGatewayService>,
    id: MessagingPlatformId
  ) => gateway.getSnapshot().platforms.find((p) => p.id === id)?.state;
  const sharedLinkOf = (
    gateway: InstanceType<typeof MessagingGatewayService>,
    id: MessagingPlatformId
  ) => gateway.getSnapshot().platforms.find((p) => p.id === id)?.sharedLink;

  /**
   * Both lanes configured, the shared bot switched on before or not, and the
   * personal connect dialog opened: its Connect turns the personal lane on,
   * which shows its login.
   */
  const openDialog = async (
    personal: Personal,
    sharedOnBefore: boolean,
    realShared = false
  ) => {
    const shared = sharedOf(personal);
    stored.on = sharedOnBefore ? [shared] : [];
    stored.configured = [personal, shared];
    const { gateway, lanes } = service(undefined, realShared);
    await gateway.syncConnectors();
    await gateway.updatePlatform({ platformId: personal, enabled: true });
    lanes.get(personal)!.onState("needs_login", "Scan the QR to connect.");
    return { gateway, lanes, shared };
  };

  /** The dialog closes unlinked and the login is given up on. */
  const abandon = async (
    gateway: InstanceType<typeof MessagingGatewayService>,
    personal: MessagingPlatformId
  ) => {
    gateway.releaseLogin(personal);
    await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
  };

  describe.each(["discord", "telegram"] as const)("%s", (personal) => {
    describe("a shared bot this connect turned on", () => {
      it.each([
        [
          "connected",
          "a link made earlier, which an Unlink left on the server",
        ],
        ["needs_login", "its pairing code, unanswered"],
        ["error", "a status check that failed before any link"],
        ["connecting", "still asking the server"],
      ])("is held with the login when it is %s (%s)", async (state) => {
        const { gateway, lanes, shared } = await openDialog(personal, false);
        // The dialog pairs the shared bot, which main switches on.
        await gateway.pairSharedChannel(shared);
        expect(gateway.runningPlatforms()).toContain(shared);
        lanes.get(shared)!.onState(state, "x");
        await abandon(gateway, personal);
        expect(held()).toEqual({
          [shared]: "login-not-finished",
          [personal]: "login-not-finished",
        });
        expect(gateway.runningPlatforms()).toEqual([]);
        // Held by the app, never by writing the user's switch off.
        expect(stored.enabled.filter((w) => w.endsWith(":false"))).toEqual([]);
      });

      it("is the user's once the login lands: a later abandoned login leaves it", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, false);
        await gateway.pairSharedChannel(shared);
        lanes.get(shared)!.onState("connected");
        lanes.get(personal)!.onState("connected");
        // Later the personal link is lost and its new login left unfinished.
        lanes.get(personal)!.onState("needs_login", "Scan the QR to connect.");
        await abandon(gateway, personal);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
      });

      it("is still this login's after a restart mid-attempt", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, false);
        await gateway.pairSharedChannel(shared);
        lanes.get(shared)!.onState("connected");
        expect(stored.loginSetup[shared]).toBe("lane");
        await gateway.dispose();
        // Relaunched: both lanes come back from the stored config.
        const next = service();
        await next.gateway.syncConnectors();
        expect(next.gateway.runningPlatforms()).toEqual(
          expect.arrayContaining([personal, shared])
        );
        next.lanes.get(shared)!.onState("connected");
        next.lanes
          .get(personal)!
          .onState("needs_login", "Scan the QR to connect.");
        await abandon(next.gateway, personal);
        expect(held()).toEqual({
          [shared]: "login-not-finished",
          [personal]: "login-not-finished",
        });
      });

      it("is the user's once they switch the personal lane off by hand", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, false);
        await gateway.pairSharedChannel(shared);
        lanes.get(shared)!.onState("connected");
        await gateway.updatePlatform({ platformId: personal, enabled: false });
        expect(stored.loginSetup[shared] ?? null).toBeNull();
        // A later connect that never pairs (the bot is linked) and is abandoned.
        await gateway.updatePlatform({ platformId: personal, enabled: true });
        lanes.get(personal)!.onState("needs_login", "Scan the QR to connect.");
        await abandon(gateway, personal);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
      });

      it("is the user's once they switch it by hand", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, false);
        await gateway.pairSharedChannel(shared);
        lanes.get(shared)!.onState("connected");
        await gateway.updatePlatform({ platformId: shared, enabled: true });
        await abandon(gateway, personal);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
      });

      it("comes back with the next Connect, and is held again if that is abandoned too", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, false);
        await gateway.pairSharedChannel(shared);
        lanes.get(shared)!.onState("connected");
        await abandon(gateway, personal);
        expect(gateway.runningPlatforms()).toEqual([]);
        // Connect again: the dialog turns the personal lane on and pairs.
        await gateway.updatePlatform({ platformId: personal, enabled: true });
        lanes.get(personal)!.onState("needs_login", "Scan the QR to connect.");
        await gateway.pairSharedChannel(shared);
        expect(stored.appStopped[shared]).toBeNull();
        expect(gateway.runningPlatforms()).toEqual(
          expect.arrayContaining([personal, shared])
        );
        await abandon(gateway, personal);
        expect(held()).toEqual({
          [shared]: "login-not-finished",
          [personal]: "login-not-finished",
        });
      });
    });

    describe("a shared bot the user already had on", () => {
      it("keeps running while connected", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, true);
        lanes.get(shared)!.onState("connected");
        await abandon(gateway, personal);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
        expect(stateOf(gateway, shared)).toBe("connected");
      });

      it.each(["error", "connecting", "rate_limited", "needs_login"])(
        "keeps running while %s at the deadline",
        async (passing) => {
          const { gateway, lanes, shared } = await openDialog(personal, true);
          lanes.get(shared)!.onState("connected");
          gateway.releaseLogin(personal);
          await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS - 10);
          lanes.get(shared)!.onState(passing, "x");
          await vi.advanceTimersByTimeAsync(10);
          expect(held()).toEqual({
            [personal]: "login-not-finished",
          });
          expect(gateway.runningPlatforms()).toContain(shared);
        }
      );

      it("keeps running when the dialog paired it again (it was already running)", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, true);
        lanes.get(shared)!.onState("needs_login", "Not linked yet.");
        await gateway.pairSharedChannel(shared);
        await abandon(gateway, personal);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
      });

      it("a cancel mid-login stops only the personal lane, once it lands on its login", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, true);
        lanes.get(shared)!.onState("connected");
        lanes.get(personal)!.onState("connecting");
        // The connect flow cancelled: it releases the login, never unlinks.
        gateway.releaseLogin(personal);
        await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS * 2);
        expect(held()).toEqual({});
        lanes.get(personal)!.onState("needs_login", "Scan the QR to connect.");
        await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
      });

      it("Connect brings the personal lane back without restarting the shared bot", async () => {
        const { gateway, lanes, shared } = await openDialog(personal, true);
        const sharedLane = lanes.get(shared)!;
        sharedLane.onState("connected");
        await abandon(gateway, personal);
        const personalBefore = lanes.get(personal);
        await gateway.updatePlatform({ platformId: personal, enabled: true });
        expect(stored.appStopped[personal]).toBeNull();
        expect(gateway.runningPlatforms()).toEqual(
          expect.arrayContaining([personal, shared])
        );
        expect(lanes.get(personal)).not.toBe(personalBefore);
        // The shared bot kept its connector: it was never stopped.
        expect(lanes.get(shared)).toBe(sharedLane);
        lanes.get(personal)!.onState("connected");
        await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
        expect(stored.appStopped[personal]).toBeNull();
      });
    });

    describe("with the shared bot's real connector and server", () => {
      /** What the server answers: the link's status, or no answer at all. */
      let server: "linked" | "unlinked" | "offline";
      /** Every call the lane made, by action. */
      let calls: string[] = [];
      const realFetch = globalThis.fetch;
      beforeEach(() => {
        calls = [];
        globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            action: string;
          };
          calls.push(body.action);
          if (server === "offline")
            throw new DOMException("This operation was aborted", "AbortError");
          if (body.action === "inbox")
            return new Promise<Response>(() => {
              // Long poll: holds while the test runs.
            });
          const linked = server === "linked";
          const answer =
            body.action === "pair"
              ? linked
                ? { status: "linked", display_name: "Me" }
                : {
                    status: "pending",
                    code: "123456",
                    deep_link: "https://t.me/bot?start=123456",
                    // A short-lived code, which the watch replaces on expiry.
                    expires_at: Date.now() / 1000 + 10,
                  }
              : {
                  available: [personal],
                  channels: linked
                    ? { [personal]: { status: "linked", display_name: "Me" } }
                    : {},
                };
          return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch;
      });
      afterEach(() => {
        globalThis.fetch = realFetch;
      });

      it.each([
        ["linked", "connected"],
        ["unlinked", "needs_login"],
        ["offline", "error"],
      ] as const)(
        "turned on by this connect with the server %s, it reads %s and is held with the login",
        async (answer, reads) => {
          server = answer;
          const { gateway, shared } = await openDialog(personal, false, true);
          await gateway.pairSharedChannel(shared).catch(() => {});
          await vi.advanceTimersByTimeAsync(0);
          expect(stateOf(gateway, shared)).toBe(reads);
          await abandon(gateway, personal);
          expect(held()).toEqual({
            [shared]: "login-not-finished",
            [personal]: "login-not-finished",
          });
          expect(gateway.runningPlatforms()).toEqual([]);
        }
      );

      it("already on and unlinked, the code this connect minted is withdrawn: the lane stays on, idle", async () => {
        server = "unlinked";
        const { gateway, shared } = await openDialog(personal, true, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(stateOf(gateway, shared)).toBe("needs_login");
        await gateway.pairSharedChannel(shared);
        expect(sharedLinkOf(gateway, shared)?.status).toBe("pending");
        // The code shown in the app's own window (the dialog's Open link).
        linkWindow.close.mockClear();
        await gateway.openSharedChannelLink(shared, "install");
        // The watch is live: it polls, and replaces the code as it runs out.
        calls = [];
        await vi.advanceTimersByTimeAsync(15_000);
        expect(calls).toContain("status");
        expect(calls).toContain("pair");
        gateway.releaseLogin(personal);
        await vi.advanceTimersByTimeAsync(RELEASED_LOGIN_MS);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
        expect(sharedLinkOf(gateway, shared)?.status).toBe("unlinked");
        // The window with the withdrawn code is gone.
        expect(linkWindow.close).toHaveBeenCalledTimes(1);
        expect(stateOf(gateway, shared)).toBe("needs_login");
        // Nothing polls or mints for it any more.
        calls = [];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls).toEqual([]);
        // The user's switch was not written.
        expect(stored.enabled).not.toContain(`${shared}:false`);
        expect(stored.loginSetup[shared] ?? null).toBeNull();
      });

      it("already on and linked, it keeps running and connected", async () => {
        server = "linked";
        const { gateway, shared } = await openDialog(personal, true, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(stateOf(gateway, shared)).toBe("connected");
        await abandon(gateway, personal);
        expect(held()).toEqual({ [personal]: "login-not-finished" });
        expect(gateway.runningPlatforms()).toEqual([shared]);
        expect(stateOf(gateway, shared)).toBe("connected");
      });
    });
  });

  it("on a host with no personal lane, pairing the shared bot records no login setup", async () => {
    stored.on = [];
    stored.configured = ["telegram", "abacus_telegram"];
    const { gateway } = service(undefined, false, "web-host");
    await gateway.syncConnectors();
    await gateway.pairSharedChannel("abacus_telegram");
    expect(gateway.runningPlatforms()).toEqual(["abacus_telegram"]);
    expect(stored.loginSetup.abacus_telegram ?? null).toBeNull();
  });

  it("WhatsApp, which has no shared bot, stops only itself and leaves other apps' lanes alone", async () => {
    stored.on = ["whatsapp", "abacus_telegram"];
    stored.configured = ["whatsapp", "abacus_telegram"];
    const { gateway, lanes } = service();
    await gateway.syncConnectors();
    lanes.get("abacus_telegram")!.onState("connected");
    lanes.get("whatsapp")!.onState("needs_login", "Scan the QR to connect.");
    await abandon(gateway, "whatsapp");
    expect(held()).toEqual({ whatsapp: "login-not-finished" });
    expect(gateway.runningPlatforms()).toEqual(["abacus_telegram"]);
    // Connect brings it back.
    await gateway.updatePlatform({ platformId: "whatsapp", enabled: true });
    expect(gateway.runningPlatforms()).toEqual(
      expect.arrayContaining(["whatsapp", "abacus_telegram"])
    );
  });
});
