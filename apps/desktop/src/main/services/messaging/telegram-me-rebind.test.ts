/**
 * A restored Telegram "me" must belong to the account that is signed in.
 *
 * A private chat with the bot has the account's own user id as its chat id,
 * so the two must agree. They did not in the field: one person's Telegram
 * was unlinked, another's signed in, and the stored selfChatId kept pointing
 * at the first person's chat — every "send me X" was delivered there with a
 * clean Bot API ack while the person at the keyboard saw nothing. The
 * restored-link path now compares the page's account id to the stored chat
 * id and relinks on mismatch.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: { getPath: () => "/tmp" },
}));

const saved: Array<Record<string, unknown>> = [];
let stored: Record<string, unknown> = {};

vi.mock("./telegram-bot-identity", () => ({
  readTelegramBotState: () => ({ ...stored }),
  saveTelegramBotState: (patch: Record<string, unknown>) => {
    saved.push(patch);
    stored = { ...stored, ...patch };
    return { ...stored };
  },
  resolveBotToken: (state: { token?: string }) => state.token ?? null,
  TelegramBotPoller: class {
    constructor(
      public token: string,
      public callbacks: unknown
    ) {}
    async getMe(): Promise<{ username: string }> {
      return { username: "TestBot" };
    }
    start(): void {}
    stop(): void {}
  },
}));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readFieldValue: () => null,
}));

const { TelegramWebConnector } = await import("./telegram-web-connector");

/** Drives ensureBotIdentity with a page whose account id is scriptable. */
const connector = (
  pageAccountId: string | null
): {
  instance: InstanceType<typeof TelegramWebConnector>;
  linked: () => boolean;
  selfLinkedFires: () => number;
} => {
  let selfLinked = 0;
  const instance = new TelegramWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: () => {},
    onSelfLinked: () => {
      selfLinked += 1;
    },
  });
  const internals = instance as unknown as {
    running: boolean;
    loggedIn: boolean;
    run: (script: string) => Promise<unknown>;
    linkSelf: () => Promise<void>;
    ensureBotIdentity: () => Promise<void>;
  };
  internals.running = true;
  internals.loggedIn = true;
  internals.run = async (script: string) =>
    script.includes("user_auth") ? { id: pageAccountId } : null;
  let linkSelfCalled = false;
  internals.linkSelf = async () => {
    linkSelfCalled = true;
  };
  return {
    instance,
    linked: () => linkSelfCalled,
    selfLinkedFires: () => selfLinked,
  };
};

describe("the restored Telegram link", () => {
  it("relinks when the signed-in account is not the stored one", async () => {
    saved.length = 0;
    stored = { token: "1:abc", username: "TestBot", selfChatId: "111" };

    const { instance, linked } = connector("222");
    await (
      instance as unknown as { ensureBotIdentity: () => Promise<void> }
    ).ensureBotIdentity();

    expect(linked()).toBe(true);
    // The stale binding is gone before the relink runs.
    expect(saved.some((patch) => "selfChatId" in patch)).toBe(true);
    expect(stored.selfChatId).toBeUndefined();
  });

  it("keeps a binding the signed-in account confirms", async () => {
    saved.length = 0;
    stored = { token: "1:abc", username: "TestBot", selfChatId: "111" };

    const { instance, linked, selfLinkedFires } = connector("111");
    await (
      instance as unknown as { ensureBotIdentity: () => Promise<void> }
    ).ensureBotIdentity();

    expect(linked()).toBe(false);
    expect(stored.selfChatId).toBe("111");
    expect(selfLinkedFires()).toBe(1);
  });

  it("does not treat an unreadable account id as a mismatch", async () => {
    saved.length = 0;
    stored = { token: "1:abc", username: "TestBot", selfChatId: "111" };

    const { instance, linked } = connector(null);
    await (
      instance as unknown as { ensureBotIdentity: () => Promise<void> }
    ).ensureBotIdentity();

    expect(linked()).toBe(false);
    expect(stored.selfChatId).toBe("111");
  });
});
