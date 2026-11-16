/**
 * Signed in to Telegram here, the shared bot's chat is opened in that page for
 * the user's Start. The window comes up only when the chat opened with
 * something to click: when it does not, nothing pops up over setup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted(() => ({ ready: "chat-not-opened" }));
const shown = vi.hoisted(() => ({ count: 0 }));

vi.mock("electron", () => {
  class FakeWindow {
    readonly webContents = {
      setAudioMuted: () => {},
      on: () => {},
      isLoading: () => false,
      executeJavaScript: async (code: string) => {
        if (code.includes("has-auth-pages"))
          return { loggedIn: true, loginVisible: false };
        if (code.includes("user_auth")) return "111";
        if (code.includes("tgaddr")) return { ready: page.ready };
        return null;
      },
    };
    loadURL = (): Promise<void> => Promise.resolve();
    removeMenu(): void {}
    on(): void {}
    isDestroyed(): boolean {
      return false;
    }
    destroy(): void {}
    isVisible(): boolean {
      return false;
    }
    hide(): void {}
  }
  return {
    BrowserWindow: FakeWindow,
    net: { isOnline: () => true },
    powerMonitor: { on: () => {}, removeListener: () => {} },
  };
});
vi.mock("../../bring-to-front", () => ({
  parentWindow: () => undefined,
  bringToFront: () => {},
  dismissOnEscape: () => {},
  presentAsDialog: () => {
    shown.count++;
  },
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => "/nonexistent" }));

const { TelegramWebConnector } = await import("./telegram-web-connector");

const lanes: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.stop();
});

const signedIn = async () => {
  const lane = new TelegramWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: () => {},
  } as never);
  lanes.push(lane);
  await lane.start();
  await lane.probeLive();
  shown.count = 0;
  return lane;
};

describe("the shared bot's Start in the signed-in Telegram page", () => {
  it("brings no window up when the bot's chat does not open", async () => {
    const lane = await signedIn();
    page.ready = "chat-not-opened";
    expect(await lane.presentBotStart("abacus_bot", "c0de")).toBe(false);
    expect(shown.count).toBe(0);
  });

  it("shows the window once there is a Start to click", async () => {
    const lane = await signedIn();
    page.ready = "start-button";
    expect(await lane.presentBotStart("abacus_bot", "c0de")).toBe(true);
    expect(shown.count).toBe(1);
  });
});
