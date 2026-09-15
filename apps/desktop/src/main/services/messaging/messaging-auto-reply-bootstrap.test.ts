/**
 * Linking a self lane — the shared Abacus AI bots, WhatsApp's "Message
 * yourself" — must leave the user with a working conversation, not a
 * dashboard of switches: the moment the link proves which chat is theirs, a
 * dedicated bot is created and that chat starts answering. Only the self
 * lane: the first cut of this feature flipped the global respondToInbound
 * switch, and a friend's WhatsApp "hi" got an auto-reply as the user the
 * moment the link finished. The bootstrap must never touch the switch that
 * governs other people.
 *
 * The invariant pinned here is ONCE EVER. The link callback re-fires on every
 * app start (restored links) and every relink, and the bootstrap must not ride
 * it into recreating a bot the user deleted — the stored per-lane flag absorbs
 * every firing after the first.
 *
 * The own-account Telegram lane once minted its own bot through BotFather and
 * bootstrapped into the single `selfBotId` slot; that lane is gone, and the
 * slot is only read as WhatsApp's fallback.
 */
import { describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

// A mutable in-memory settings store standing in for the config file, so the
// bootstrap's own writes are visible to its later reads.
const settings = {
  gatewayEnabled: true,
  autoApproveTools: true,
  respondToInbound: false,
  workspaceId: null as string | null,
  botId: null as string | null,
  selfBotId: null as string | null,
  selfBotIds: {} as Partial<Record<MessagingPlatformId, string | null>>,
  autoReplyBootstrapped: false,
  autoReplyBootstrappedFor: [] as MessagingPlatformId[],
};

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({ ...settings }),
  saveGatewaySettings: (patch: Partial<typeof settings>) => {
    // Mirror the real merge semantics for the per-platform fields.
    const { selfBotIds, autoReplyBootstrappedFor, ...rest } = patch;
    Object.assign(settings, rest);
    if (selfBotIds != null)
      settings.selfBotIds = { ...settings.selfBotIds, ...selfBotIds };
    if (autoReplyBootstrappedFor != null)
      settings.autoReplyBootstrappedFor = [
        ...new Set([
          ...settings.autoReplyBootstrappedFor,
          ...autoReplyBootstrappedFor,
        ]),
      ];
  },
  isPlatformEnabled: (id: MessagingPlatformId) =>
    id === "telegram" ||
    id === "abacus_discord" ||
    id === "abacus_telegram" ||
    id === "whatsapp",
  isPlatformConfigured: (id: MessagingPlatformId) =>
    id === "telegram" ||
    id === "abacus_discord" ||
    id === "abacus_telegram" ||
    id === "whatsapp",
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

type Callbacks = { onSelfLinked?: () => void };

const service = (): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  captured: Callbacks[];
  /** The same callbacks, by the platform they were built for. */
  byId: Map<MessagingPlatformId, Callbacks>;
  createCalls: string[];
} => {
  const captured: Callbacks[] = [];
  const byId = new Map<MessagingPlatformId, Callbacks>();
  const createCalls: string[] = [];

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    createAutoReplyBot: (platform: string) => {
      createCalls.push(platform);
      return platform === "abacus_telegram"
        ? "bot-telegram"
        : platform === "whatsapp"
          ? "bot-whatsapp"
          : "bot-discord";
    },
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
    // Reuse the real callback wiring — the bootstrap trigger is what is
    // under test, and rebuilding it here would test the test.
    const real = build(id) as { callbacks: Callbacks };
    captured.push(real.callbacks);
    byId.set(id, real.callbacks);
    return {
      id,
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      callbacks: real.callbacks,
    };
  };

  return { gateway, captured, byId, createCalls };
};

const linked = async (): Promise<{
  captured: Callbacks[];
  byId: Map<MessagingPlatformId, Callbacks>;
  createCalls: string[];
}> => {
  const built = service();
  await built.gateway.syncConnectors();
  return built;
};

const reset = (): void => {
  settings.respondToInbound = false;
  settings.botId = null;
  settings.selfBotId = null;
  settings.selfBotIds = {};
  settings.autoReplyBootstrapped = false;
  settings.autoReplyBootstrappedFor = [];
};

describe("the Abacus AI Telegram self-lane bootstrap", () => {
  it("creates its own bot on first link, once ever", async () => {
    reset();
    const { byId, createCalls } = await linked();
    const telegram = byId.get("abacus_telegram")!;
    telegram.onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_telegram"]);
    expect(settings.selfBotIds.abacus_telegram).toBe("bot-telegram");
    // The global switch answers every chat as the user — the bootstrap must
    // leave it exactly where the user had it, and the general bot alone.
    expect(settings.botId).toBeNull();
    expect(settings.respondToInbound).toBe(false);
    expect(settings.autoReplyBootstrappedFor).toEqual(["abacus_telegram"]);

    // Restored links and relinks re-fire the callback; nothing happens.
    telegram.onSelfLinked?.();
    telegram.onSelfLinked?.();
    expect(createCalls).toHaveLength(1);
  });

  it("is not triggered by the user's own Telegram account linking", async () => {
    // The own-account lane reads and sends as the user; it has no self chat
    // of its own any more, so it mints nothing and touches no slot.
    reset();
    const { byId, createCalls } = await linked();
    byId.get("telegram")!.onSelfLinked?.();

    expect(createCalls).toHaveLength(0);
    expect(settings.selfBotId).toBeNull();
    expect(settings.selfBotIds).toEqual({});
    expect(settings.autoReplyBootstrapped).toBe(false);
  });

  it("leaves the retired bootstrap's slot as it found it", async () => {
    // The old own-account bootstrap parked its bot in selfBotId. The shared
    // lane's bootstrap adopts that bot by name in service-host; here it must
    // simply not rewrite the slot, so WhatsApp's fallback keeps working.
    reset();
    settings.selfBotId = "bot-auto-reply";
    settings.autoReplyBootstrapped = true;

    const { byId, createCalls } = await linked();
    byId.get("abacus_telegram")!.onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_telegram"]);
    expect(settings.selfBotIds.abacus_telegram).toBe("bot-telegram");
    expect(settings.selfBotId).toBe("bot-auto-reply");
    expect(settings.autoReplyBootstrapped).toBe(true);
  });
});

/**
 * The Abacus AI Discord bot's chat is a lane of its own. The first cut fed
 * it through the old Telegram bootstrap, so the Discord DM turned up in the
 * app under "AbacusAI Bot <-> You" — a bot whose brief said it lived in
 * Telegram.
 */
describe("the Abacus AI Discord self-lane bootstrap", () => {
  it("creates its own bot on first link, once ever", async () => {
    reset();
    const { byId, createCalls } = await linked();
    const discord = byId.get("abacus_discord")!;
    discord.onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_discord"]);
    expect(settings.selfBotIds.abacus_discord).toBe("bot-discord");
    // The other slots are not its business.
    expect(settings.selfBotId).toBeNull();
    expect(settings.botId).toBeNull();
    expect(settings.autoReplyBootstrapped).toBe(false);
    expect(settings.respondToInbound).toBe(false);
    expect(settings.autoReplyBootstrappedFor).toEqual(["abacus_discord"]);

    discord.onSelfLinked?.();
    discord.onSelfLinked?.();
    expect(createCalls).toEqual(["abacus_discord"]);
  });

  it("still gets its own bot when the retired bootstrap had run", async () => {
    reset();
    settings.selfBotId = "bot-auto-reply";
    settings.autoReplyBootstrapped = true;

    const { byId, createCalls } = await linked();
    byId.get("abacus_discord")!.onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_discord"]);
    expect(settings.selfBotIds.abacus_discord).toBe("bot-discord");
    expect(settings.selfBotId).toBe("bot-auto-reply");
  });

  it("keeps its slot when the Telegram lane links later", async () => {
    reset();
    const { byId, createCalls } = await linked();
    byId.get("abacus_discord")!.onSelfLinked?.();
    byId.get("abacus_telegram")!.onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_discord", "abacus_telegram"]);
    expect(settings.selfBotIds.abacus_discord).toBe("bot-discord");
    expect(settings.selfBotIds.abacus_telegram).toBe("bot-telegram");
  });
});

/**
 * WhatsApp's "Message yourself" chat is a self lane like the others: the link
 * proving the user's own number mints its bot and that chat starts answering,
 * with nothing to switch on. It used to ride the old Telegram bootstrap bot,
 * so a WhatsApp-only user got no bot at all — and the global switch stays off.
 */
describe("the WhatsApp self-lane bootstrap", () => {
  it("creates its own bot on first link, once ever", async () => {
    reset();
    const { byId, createCalls } = await linked();
    byId.get("whatsapp")!.onSelfLinked?.();

    expect(createCalls).toEqual(["whatsapp"]);
    expect(settings.selfBotIds.whatsapp).toBe("bot-whatsapp");
    expect(settings.selfBotId).toBeNull();
    expect(settings.botId).toBeNull();
    expect(settings.respondToInbound).toBe(false);
    expect(settings.autoReplyBootstrappedFor).toEqual(["whatsapp"]);

    byId.get("whatsapp")!.onSelfLinked?.();
    expect(createCalls).toEqual(["whatsapp"]);
  });

  it("gets its own bot even when the retired bootstrap had run", async () => {
    reset();
    settings.selfBotId = "bot-auto-reply";
    settings.autoReplyBootstrapped = true;

    const { byId, createCalls } = await linked();
    byId.get("whatsapp")!.onSelfLinked?.();

    expect(createCalls).toEqual(["whatsapp"]);
    expect(settings.selfBotIds.whatsapp).toBe("bot-whatsapp");
    expect(settings.selfBotId).toBe("bot-auto-reply");
  });
});
