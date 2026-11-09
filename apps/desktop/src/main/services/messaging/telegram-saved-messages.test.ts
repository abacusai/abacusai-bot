/**
 * Personal Telegram's Saved Messages is one way to reach the user. It must
 * always be the account signed in now: after a sign-out and a sign-in as
 * someone else, a message to "me" (a routine's report, say) must never land
 * in the previous account's Saved Messages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** The page as the driver scripts read it. */
const page = vi.hoisted(() => ({
  signedIn: true,
  account: "111",
  chats: [] as Array<{ chatId: string; name: string }>,
}));

vi.mock("electron", () => {
  class FakeWindow {
    readonly webContents = {
      setAudioMuted: () => {},
      on: () => {},
      isLoading: () => false,
      executeJavaScript: async (code: string) => {
        if (code.includes("has-auth-pages"))
          return { loggedIn: page.signedIn, loginVisible: !page.signedIn };
        if (code.includes("user_auth"))
          return page.signedIn ? page.account : null;
        if (code.includes("rows.push({ chatId: id, name })")) return page.chats;
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
  presentAsDialog: () => {},
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => "/nonexistent" }));

const { TelegramWebConnector } = await import("./telegram-web-connector");

const connectors: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const connector of connectors.splice(0)) await connector.stop();
});

/** Sign in as `account` and let the list (with its Saved Messages row) be read. */
const signIn = async (
  lane: InstanceType<typeof TelegramWebConnector>,
  account: string
): Promise<void> => {
  page.signedIn = true;
  page.account = account;
  page.chats = [
    { chatId: account, name: "Saved Messages" },
    { chatId: "500", name: "Ana" },
  ];
  await lane.probeLive();
  await (
    lane as unknown as { refreshContacts(): Promise<void> }
  ).refreshContacts();
};

const signOut = async (
  lane: InstanceType<typeof TelegramWebConnector>
): Promise<void> => {
  page.signedIn = false;
  // A sign-out is believed on the second signed-out check.
  await lane.probeLive();
  await lane.probeLive();
};

describe("Telegram's Saved Messages as a way to the user", () => {
  it("is always the account signed in now", async () => {
    const lane = new TelegramWebConnector({
      onMessage: () => {},
      onState: () => {},
      onLog: () => {},
    } as never);
    connectors.push(lane);
    page.signedIn = false;
    await lane.start();

    await signIn(lane, "111");
    expect(lane.ownChatForSend()).toBe("111");

    await signOut(lane);
    expect(lane.ownChatForSend()).toBeNull();

    // Signed in as someone else: their Saved Messages, never the last account's.
    await signIn(lane, "222");
    expect(lane.ownChatForSend()).toBe("222");
  });

  it("is forgotten when the lane stops", async () => {
    const lane = new TelegramWebConnector({
      onMessage: () => {},
      onState: () => {},
      onLog: () => {},
    } as never);
    page.signedIn = false;
    await lane.start();
    await signIn(lane, "111");
    await lane.stop();
    expect(lane.ownChatForSend()).toBeNull();
  });
});
