// @vitest-environment jsdom
/**
 * Personal Telegram's chat list, read the way Telegram Web lays it out: a
 * row's title line holds the name and the last message's time. The name must
 * come back alone. With the time stuck on ("Abacus AI01:46") the shared Abacus
 * AI bot's chat no longer matched the bot's name, so the personal lane took
 * the agent's own messages there for a person's and answered them, and the
 * answer came back to the agent as the user's message.
 */
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, net: {} }));
vi.mock("../../bring-to-front", () => ({}));
vi.mock("../../paths", () => ({ abacusBotHome: () => "/nonexistent" }));

/** Auto-reply at its most open: on, every private chat answered, the bot's chat approved. */
vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    answerPrivateChats: true,
    workspaceId: "ws",
    botId: null,
    autoReplyBootstrapped: true,
    autoReplyPausedUntil: 0,
  }),
  saveGatewaySettings: () => {},
  isPlatformEnabled: () => true,
  isPlatformConfigured: () => true,
  approvedUserIds: () => new Set<string>(["7001", "7002"]),
  findPairing: () => ({ status: "approved" }),
  recordPairingRequest: () => {},
  approvePairing: () => {},
  listPairing: () => [],
}));

const { TelegramWebConnector } = await import("./telegram-web-connector");
const { AbacusChannelsConnector } = await import("./abacus-channels-connector");
const { MessagingGatewayService } = await import("./messaging-gateway-service");

/** One chat row as Telegram Web K renders it, unread when `unread` > 0. */
const row = (
  peerId: string,
  name: string,
  time: string,
  preview: string,
  unread = 0
): string => `
  <a class="row chatlist-chat" data-peer-id="${peerId}">
    <div class="row-row row-title-row dialog-title">
      <div class="row-title user-title"><span class="peer-title" data-peer-id="${peerId}">${name}</span></div>
      <div class="row-title row-title-right dialog-title-details"><span class="message-status"></span><span class="message-time">${time}</span></div>
    </div>
    <div class="row-row row-subtitle-row dialog-subtitle">
      <div class="row-subtitle"><span class="dialog-subtitle-span">${preview}</span></div>
      ${unread > 0 ? `<div class="dialog-subtitle-badge badge dialog-subtitle-badge-unread">${unread}</div>` : ""}
    </div>
  </a>`;

type Inbound = {
  userId: string;
  userName: string | null;
  chatId: string;
  text: string;
};

const lane = (onMessage: (message: Inbound) => void = () => {}) => {
  const messages: Inbound[] = [];
  const connector = new TelegramWebConnector({
    onMessage: (message) => {
      messages.push(message);
      onMessage(message);
    },
    onState: () => {},
    onLog: () => {},
  });
  const inside = connector as unknown as {
    running: boolean;
    loggedIn: boolean;
    window: unknown;
    sweepInbound: () => Promise<void>;
  };
  inside.running = true;
  inside.loggedIn = true;
  inside.window = {
    isDestroyed: () => false,
    // Evaluated in this DOM, as the page would run it.
    webContents: {
      executeJavaScript: async (code: string): Promise<unknown> =>
        Function(`return ${code}`)(),
    },
  };
  return { connector, inside, messages };
};

describe("personal Telegram's chat names", () => {
  it("are the names alone, without the last message's time", async () => {
    document.body.innerHTML = `<ul class="chatlist">
      ${row("7001", "Abacus AI", "01:46", "Your page is live")}
      ${row("7002", "Marc 2", "23:50", "see you")}
    </ul>`;
    const { connector, inside } = lane();
    await inside.sweepInbound();

    expect(connector.listContacts()).toEqual([
      { chatId: "7001", name: "Abacus AI" },
      { chatId: "7002", name: "Marc 2" },
    ]);
  });

  it("names a new message's sender without the time", async () => {
    document.body.innerHTML = `<ul class="chatlist">
      ${row("7001", "Abacus AI", "01:46", "Your page is live")}
    </ul>`;
    const { inside, messages } = lane();
    // The first sweep only learns what is already there.
    await inside.sweepInbound();
    document.body.innerHTML = `<ul class="chatlist">
      ${row("7001", "Abacus AI", "01:51", "Here is the link", 1)}
    </ul>`;
    await inside.sweepInbound();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      chatId: "7001",
      userName: "Abacus AI",
    });
  });
});

describe("the shared Abacus AI bot's chat on personal Telegram", () => {
  /** Both Telegram lanes as the gateway runs them, the shared bot linked as "Abacus AI". */
  const gatewayWithLanes = () => {
    const prompts: string[] = [];
    const replies: string[] = [];
    const gateway = new MessagingGatewayService({
      resolveWorkspaceId: () => "ws",
      createAgentSession: () => ({ id: "session-1" }) as never,
      updateSessionLabel: () => {},
      startSession: async () => ({ success: true }) as never,
      sendMessage: (_w: string, _s: string, message: string) => {
        prompts.push(message);
      },
      emitUserMessage: () => {},
      emitChanged: () => {},
      isSessionBusy: () => false,
    } as never);
    const inside = gateway as unknown as {
      connectors: Map<string, unknown>;
      handleInbound: (id: MessagingPlatformId, m: Inbound) => Promise<void>;
    };
    const shared = new AbacusChannelsConnector(
      { onMessage: () => {}, onState: () => {}, onLog: () => {} },
      "telegram"
    );
    Object.assign(shared, { linked: true, botName: "Abacus AI" });
    inside.connectors.set("abacus_telegram", shared);
    const pending: Array<Promise<void>> = [];
    const personal = lane((message) => {
      pending.push(inside.handleInbound("telegram", message));
    });
    Object.assign(personal.connector, {
      sendText: async (_chatId: string, text: string) => {
        replies.push(text);
      },
    });
    inside.connectors.set("telegram", personal.connector);
    return { personal, prompts, replies, settled: () => Promise.all(pending) };
  };

  it("never starts a turn from the agent's own message there", async () => {
    document.body.innerHTML = `<ul class="chatlist">
      ${row("7001", "Abacus AI", "08:21", "Describe what you want")}
      ${row("7002", "Marc", "08:20", "ok")}
    </ul>`;
    const h = gatewayWithLanes();
    await h.personal.inside.sweepInbound();
    // The agent's own answer arrives in its chat; a friend writes too.
    document.body.innerHTML = `<ul class="chatlist">
      ${row("7001", "Abacus AI", "08:22", "Hi! I live in your Telegram", 1)}
      ${row("7002", "Marc", "08:22", "are you coming?", 1)}
    </ul>`;
    await h.personal.inside.sweepInbound();
    await h.settled();

    // Marc's message is answered; the bot's is not, so nothing goes back to it.
    expect(h.personal.messages.map((m) => m.chatId)).toEqual(["7001", "7002"]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("are you coming?");
    expect(h.prompts.join("\n")).not.toContain("I live in your Telegram");
    expect(h.replies).toEqual([]);
  });
});
