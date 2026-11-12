/**
 * How each chat-app page reports a failure to the gateway's lane supervisor.
 *
 * A page load that failed while the OS still said "online" (DNS down after a
 * power cut) parked the lane as an error nothing ever retried: the only retry
 * waited on the OS online flag. A failure must say it may be retried, or the
 * supervisor leaves it for the user, and the lane stays dead with the app open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

class FakeWindow {
  static last: FakeWindow | null = null;
  destroyed = false;
  private readonly listeners = new Map<string, Listener[]>();
  readonly webContents = {
    setAudioMuted: () => {},
    setUserAgent: () => {},
    on: (event: string, listener: Listener) => {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
    },
    off: () => {},
    isLoading: () => false,
    // A page that answers nothing useful yet: neither signed in nor a login.
    executeJavaScript: async () => ({ loggedIn: false, loginVisible: false }),
  };
  constructor() {
    FakeWindow.last = this;
  }
  loadURL = (): Promise<void> => Promise.resolve();
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? [])
      listener({}, ...args);
  }
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
    return false;
  }
  show(): void {}
  hide(): void {}
}

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  // Online throughout: the bug's condition.
  net: { isOnline: () => true },
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
  presentAsDialog: () => {},
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => "/nonexistent" }));
vi.mock("./messaging-config-service", () => ({
  readPlatformLinkLost: () => false,
  readPlatformSignedIn: () => null,
  savePlatformLinkLost: () => {},
  savePlatformSignedIn: () => {},
}));

const { TelegramWebConnector } = await import("./telegram-web-connector");
const { DiscordWebConnector } = await import("./discord-web-connector");
const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");

type Lane = { start: () => Promise<void>; stop: () => Promise<void> };
type Reported = { state: string; failure: unknown };

const CONNECTORS = [
  ["WhatsApp", WhatsAppWebConnector, "https://web.whatsapp.com/"],
  ["Discord", DiscordWebConnector, "https://discord.com/app"],
  ["Telegram", TelegramWebConnector, "https://web.telegram.org/k/"],
] as const;

const lanes: Lane[] = [];
afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.stop();
});

const started = async (
  Connector: (typeof CONNECTORS)[number][1]
): Promise<{ window: FakeWindow; reported: Reported[] }> => {
  const reported: Reported[] = [];
  const lane = new Connector({
    onMessage: () => {},
    onState: (state: string, _note?: string, failure?: unknown) =>
      reported.push({ state, failure }),
    onLog: () => {},
  } as never) as unknown as Lane;
  lanes.push(lane);
  await lane.start();
  return { window: FakeWindow.last!, reported };
};

describe.each(CONNECTORS)("%s", (_name, Connector, url) => {
  it("reports a page that failed to load while online as retryable", async () => {
    const { window, reported } = await started(Connector);
    window.emit("did-fail-load", -105, "ERR_NAME_NOT_RESOLVED", url, true);
    expect(reported.at(-1)?.state).toBe("error");
    expect(reported.at(-1)?.failure).toMatchObject({ retry: "auto" });
    expect(window.destroyed).toBe(true);
  });

  it("reports a crashed page as retryable", async () => {
    const { window, reported } = await started(Connector);
    window.emit("render-process-gone", { reason: "crashed" });
    expect(reported.at(-1)).toEqual({
      state: "error",
      failure: { retry: "auto" },
    });
    expect(window.destroyed).toBe(true);
  });
});

describe.each(CONNECTORS.slice(0, 2))("%s", (_name, Connector, url) => {
  it("labels a refused certificate, which the supervisor retries only a few times", async () => {
    const { window, reported } = await started(Connector);
    window.emit("certificate-error", url, "net::ERR_CERT_AUTHORITY_INVALID");
    expect(reported.at(-1)).toEqual({
      state: "error",
      failure: { retry: "auto", cert: true },
    });
  });
});
