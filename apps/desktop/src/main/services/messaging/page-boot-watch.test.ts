/**
 * A hidden Discord or Telegram Web page that has not booted: when it is
 * reloaded, and when the lane stops and waits for the user.
 *
 * Two failures, one policy:
 *
 * - Telegram Web on a network that could not reach it reloaded every few
 *   seconds for as long as the app ran: hundreds of reloads in an afternoon,
 *   each one a timed-out load, and the card never said anything was wrong.
 * - Discord on a slow link was reloaded every 30 seconds whether or not the
 *   page was still fetching its bundle, so a boot that needed longer than that
 *   was thrown away three times and the lane gave up with "Discord did not
 *   finish loading". The same page left alone came up with its login.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the fake page shows, and whether it is still fetching. */
const page = {
  shows: { loggedIn: false, loginVisible: false } as {
    loggedIn: boolean;
    loginVisible: boolean;
  },
  loading: false,
  online: true,
  loads: 0,
  /** What Telegram's send script answers, in order; then success. */
  sends: [] as Array<{ ok: boolean; error?: string }>,
  /** Run as each load starts, as a real page boots. */
  onLoad: null as (() => void) | null,
  /** Every load hangs: it never settles, as some did in the field. */
  hang: false,
};

class FakeWindow {
  destroyed = false;
  visible = false;
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly webContents = {
    setAudioMuted: () => {},
    setUserAgent: () => {},
    on: (event: string, listener: () => void) => {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
    },
    off: () => {},
    isLoading: () => page.loading,
    executeJavaScript: async (code: string) =>
      code.includes("requirePeerId")
        ? (page.sends.shift() ?? { ok: true })
        : page.shows,
  };
  loadURL = (): Promise<void> => {
    page.loads += 1;
    for (const listener of this.listeners.get("did-start-loading") ?? [])
      listener();
    page.onLoad?.();
    return page.hang ? new Promise<void>(() => {}) : Promise.resolve();
  };
  removeMenu(): void {}
  on(): void {}
  off(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
  isVisible(): boolean {
    return this.visible;
  }
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  net: { isOnline: () => page.online },
  // The Discord partition's loopback refusal (closeDiscordLoopback).
  session: {
    fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }),
  },
  powerMonitor: { on: () => {}, removeListener: () => {} },
}));
vi.mock("../../bring-to-front", () => ({
  parentWindow: () => undefined,
  bringToFront: () => {},
  dismissOnEscape: () => {},
  presentAsDialog: (win: FakeWindow) => win.show(),
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => "/nonexistent" }));
vi.mock("./messaging-config-service", () => ({
  readPlatformLinkLost: () => false,
  readPlatformSignedIn: () => null,
  savePlatformLinkLost: () => {},
  savePlatformSignedIn: () => {},
}));

const { PageBootWatch } = await import("./page-boot-watch");
const { TelegramWebConnector } = await import("./telegram-web-connector");
const { DiscordWebConnector } = await import("./discord-web-connector");
const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");

type Lane = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  showLoginWindow: () => void;
  sendText: (chatId: string, text: string) => Promise<void>;
};

const lanes: Lane[] = [];

afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.stop();
  vi.useRealTimers();
  Object.assign(page, {
    shows: { loggedIn: false, loginVisible: false },
    loading: false,
    online: true,
    loads: 0,
    sends: [],
    onLoad: null,
    hang: false,
  });
});

const states: Array<{ state: string; message?: string }> = [];
/** The retry label on the last state, for the gateway's supervisor. */
let lastFailure: unknown = undefined;
const callbacks = {
  onMessage: () => {},
  onState: (state: string, message?: string, failure?: unknown) => {
    states.push({ state, message });
    lastFailure = failure;
  },
  onLog: () => {},
};

const startLane = async (
  Connector:
    | typeof TelegramWebConnector
    | typeof DiscordWebConnector
    | typeof WhatsAppWebConnector
): Promise<Lane> => {
  states.length = 0;
  const lane = new Connector(callbacks as never) as unknown as Lane;
  lanes.push(lane);
  await lane.start();
  return lane;
};

describe("the boot watch", () => {
  it.each([
    // [what the polls see, seconds between polls, polls, verdicts seen]
    ["an idle page waits 30s, then reloads", null, 1.5, 21, ["reload"]],
    ["a page still fetching is not reloaded", "loading", 1.5, 190, []],
    ["a load past five minutes is wedged", "loading", 1.5, 230, ["reload"]],
    ["time offline never counts", "offline", 1.5, 4000, []],
    ["a page starting up waits out the cap", "starting", 1.5, 4000, []],
    [
      "each reload doubles the wait, then it gives up",
      null,
      10,
      100,
      ["reload", "reload", "reload", "give_up"],
    ],
  ] as const)("%s", (_name, busy, everyS, polls, expected) => {
    const watch = new PageBootWatch();
    const seen: string[] = [];
    for (let i = 0; i < polls; i += 1) {
      const verdict = watch.stuck(i * everyS * 1000, busy);
      if (verdict !== "wait") seen.push(verdict);
      if (verdict === "give_up") break;
    }
    expect(seen).toEqual(expected);
  });

  it("starts over once the page boots", () => {
    const watch = new PageBootWatch(1000, 1);
    expect(watch.stuck(0, null)).toBe("wait");
    expect(watch.stuck(1000, null)).toBe("reload");
    watch.reset();
    expect(watch.reloadCount).toBe(0);
    expect(watch.stuck(5000, null)).toBe("wait");
    expect(watch.stuck(6000, null)).toBe("reload");
  });
});

describe("a Telegram Web page that cannot be reached", () => {
  it("is reloaded a few times, then the lane parks for the gateway to retry", async () => {
    vi.useFakeTimers();
    await startLane(TelegramWebConnector);
    const initial = page.loads;

    // An afternoon of a network that never lets Telegram Web load.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(page.loads - initial).toBe(3);
    expect(states.at(-1)).toEqual({
      state: "error",
      message:
        "Telegram Web did not finish loading. It tries again by itself, or click Connect to try now.",
    });
  });

  it("does not count time the machine is offline", async () => {
    vi.useFakeTimers();
    page.online = false;
    await startLane(TelegramWebConnector);
    const initial = page.loads;

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(page.loads - initial).toBe(0);
    expect(states.at(-1)?.state).toBe("connecting");
  });

  it("comes back when the user opens Telegram", async () => {
    vi.useFakeTimers();
    const lane = await startLane(TelegramWebConnector);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(states.at(-1)?.state).toBe("error");

    page.shows = { loggedIn: false, loginVisible: true };
    lane.showLoginWindow();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(states.at(-1)?.message).toContain("Scan the QR");
  });
});

describe("a Discord page on a slow link", () => {
  it("is left to finish loading, and shows its login when it does", async () => {
    vi.useFakeTimers();
    page.loading = true;
    await startLane(DiscordWebConnector);
    const initial = page.loads;

    // Two minutes for the bundle, far past the old 30s reload timer.
    await vi.advanceTimersByTimeAsync(120_000);
    page.loading = false;
    page.shows = { loggedIn: false, loginVisible: true };
    await vi.advanceTimersByTimeAsync(5_000);

    expect(page.loads - initial).toBe(0);
    expect(states.at(-1)).toEqual({
      state: "needs_login",
      message: "Discord is not signed in. Sign in to connect.",
    });
  });
});

describe("a signed-in Telegram page reloaded to retry a send", () => {
  // web-k shows its auth screen for a moment while a fresh page reads the
  // stored session; read as a sign-out, the card flipped to "not connected".
  const connected = async (): Promise<Lane> => {
    vi.useFakeTimers();
    page.shows = { loggedIn: true, loginVisible: false };
    const lane = await startLane(TelegramWebConnector);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)?.state).toBe("connected");
    return lane;
  };

  it("is not reported signed out while the fresh page boots", async () => {
    const lane = await connected();
    page.sends = [{ ok: false, error: "Could not type into the composer." }];
    page.onLoad = () => {
      page.shows = { loggedIn: false, loginVisible: true };
      setTimeout(() => {
        page.shows = { loggedIn: true, loginVisible: false };
      }, 4_500);
    };

    const sent = lane.sendText("-100", "hello");
    await vi.advanceTimersByTimeAsync(10_000);
    await sent;

    expect(states.map(({ state }) => state)).not.toContain("needs_login");
  });

  it("still reports a session that really ended", async () => {
    await connected();
    page.shows = { loggedIn: false, loginVisible: true };
    await vi.advanceTimersByTimeAsync(5_000);

    expect(states.map(({ message }) => message)).toContain(
      "Telegram is signed out. The session was ended from another device or expired. Reconnect to sign in again."
    );
  });
});

describe("a first page load that never settles", () => {
  // Field logs: the first load of a hidden page that never finished left the
  // lane on "connecting" for hours, checked by nothing, until a restart.
  it.each([
    [
      "WhatsApp",
      WhatsAppWebConnector,
      "error",
      "WhatsApp Web did not finish loading. It tries again by itself, or click Connect to try now.",
    ],
    [
      "Telegram",
      TelegramWebConnector,
      "error",
      "Telegram Web did not finish loading. It tries again by itself, or click Connect to try now.",
    ],
  ] as const)(
    "%s: is reloaded a few times, then the lane parks for the gateway to retry",
    async (_name, Connector, state, message) => {
      vi.useFakeTimers();
      page.loading = true;
      page.hang = true;
      states.length = 0;
      const lane = new Connector(callbacks as never) as unknown as Lane;
      lanes.push(lane);
      void lane.start();

      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

      expect(page.loads).toBeGreaterThan(1);
      expect(states.at(-1)).toEqual({ state, message });
      // A page that loaded and never booted: retried, at the slow pace.
      expect(lastFailure).toEqual({ retry: "auto", stuckBoot: true });
    }
  );

  it("WhatsApp: a page that loaded and is starting up is never reloaded", async () => {
    vi.useFakeTimers();
    await startLane(WhatsAppWebConnector);

    // Neither the chat list nor the QR, but not loading: a fresh link's sync.
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(page.loads).toBe(1);
    expect(states.at(-1)?.state).toBe("connecting");
  });
});
