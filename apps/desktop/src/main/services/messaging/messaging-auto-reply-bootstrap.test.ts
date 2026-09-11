/**
 * Connecting Telegram must leave the user with a working conversation, not a
 * dashboard of switches: the moment the link proves which chat is theirs, a
 * dedicated bot is created and the SELF LANE — the user's own chat — starts
 * answering. Only the self lane: the first cut of this feature flipped the
 * global respondToInbound switch, and a friend's WhatsApp "hi" got an
 * auto-reply as the user the moment Telegram finished linking. The bootstrap
 * must never touch the switch that governs other people.
 *
 * The invariant pinned here is ONCE EVER. The link callback re-fires on every
 * app start (restored links) and every relink, and the bootstrap must not ride
 * it into recreating a bot the user deleted or flipping switches they turned
 * off — the stored flag absorbs every firing after the first, including the
 * case where the user had already configured auto-reply themselves.
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
    id === "telegram" || id === "abacus_discord" || id === "whatsapp",
  isPlatformConfigured: (id: MessagingPlatformId) =>
    id === "telegram" || id === "abacus_discord" || id === "whatsapp",
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
      return platform === "telegram"
        ? "bot-auto-reply"
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

describe("the Telegram auto-reply bootstrap", () => {
  it("creates the bot for the self lane on first link, once ever", async () => {
    settings.respondToInbound = false;
    settings.botId = null;
    settings.selfBotId = null;
    settings.autoReplyBootstrapped = false;

    const { captured, createCalls } = await linked();
    captured[0]!.onSelfLinked?.();

    expect(createCalls).toEqual(["telegram"]);
    // The SELF slot, never the general one: the general botId routes every
    // approved sender, and the bootstrap bot parked there once collected a
    // WhatsApp group's auto-reply conversations.
    expect(settings.selfBotId).toBe("bot-auto-reply");
    expect(settings.botId).toBeNull();
    // The global switch answers every chat as the user — the bootstrap must
    // leave it exactly where the user had it.
    expect(settings.respondToInbound).toBe(false);
    expect(settings.autoReplyBootstrapped).toBe(true);

    // Restored links and relinks re-fire the callback; nothing happens.
    captured[0]!.onSelfLinked?.();
    captured[0]!.onSelfLinked?.();
    expect(createCalls).toHaveLength(1);
  });

  it("moves a legacy bootstrap bot out of the general slot", async () => {
    settings.respondToInbound = false;
    settings.botId = "bootstrap-bot";
    settings.selfBotId = null;
    settings.autoReplyBootstrapped = true;

    const { captured, createCalls } = await linked();
    captured[0]!.onSelfLinked?.();

    expect(createCalls).toHaveLength(0);
    expect(settings.selfBotId).toBe("bootstrap-bot");
    expect(settings.botId).toBeNull();
  });

  it("leaves a user who already configured auto-reply alone", async () => {
    settings.respondToInbound = true;
    settings.botId = "their-own-bot";
    settings.selfBotId = null;
    settings.autoReplyBootstrapped = false;

    const { captured, createCalls } = await linked();
    captured[0]!.onSelfLinked?.();

    expect(createCalls).toHaveLength(0);
    expect(settings.botId).toBe("their-own-bot");
    // The flag still burns, so a later reset of their config doesn't
    // resurrect the bootstrap behind their back.
    expect(settings.autoReplyBootstrapped).toBe(true);
  });

  it("does not re-run after the user turned auto-reply off", async () => {
    settings.respondToInbound = false;
    settings.botId = null;
    settings.selfBotId = null;
    settings.autoReplyBootstrapped = true;

    const { captured, createCalls } = await linked();
    captured[0]!.onSelfLinked?.();

    expect(createCalls).toHaveLength(0);
    expect(settings.respondToInbound).toBe(false);
  });
});

/**
 * The Abacus AI Discord bot's chat is a lane of its own. The first cut fed
 * it through the Telegram bootstrap, so the Discord DM turned up in the app
 * under "AbacusAI Bot <-> You" — a bot whose brief says it lives in Telegram.
 */
describe("the Abacus AI Discord self-lane bootstrap", () => {
  const reset = (): void => {
    settings.respondToInbound = false;
    settings.botId = null;
    settings.selfBotId = null;
    settings.selfBotIds = {};
    settings.autoReplyBootstrapped = false;
    settings.autoReplyBootstrappedFor = [];
  };
  const discordOf = (captured: Callbacks[]): Callbacks => captured[1]!;

  it("creates its own bot on first link, once ever", async () => {
    reset();
    const { captured, createCalls } = await linked();
    discordOf(captured).onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_discord"]);
    expect(settings.selfBotIds.abacus_discord).toBe("bot-discord");
    // Telegram's slots are not its business.
    expect(settings.selfBotId).toBeNull();
    expect(settings.botId).toBeNull();
    expect(settings.autoReplyBootstrapped).toBe(false);
    expect(settings.respondToInbound).toBe(false);
    expect(settings.autoReplyBootstrappedFor).toEqual(["abacus_discord"]);

    discordOf(captured).onSelfLinked?.();
    discordOf(captured).onSelfLinked?.();
    expect(createCalls).toEqual(["abacus_discord"]);
  });

  it("still gets its own bot when Telegram already bootstrapped", async () => {
    reset();
    settings.selfBotId = "bot-auto-reply";
    settings.autoReplyBootstrapped = true;

    const { captured, createCalls } = await linked();
    discordOf(captured).onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_discord"]);
    expect(settings.selfBotIds.abacus_discord).toBe("bot-discord");
    expect(settings.selfBotId).toBe("bot-auto-reply");
  });

  it("leaves Telegram's bootstrap untouched when it links later", async () => {
    reset();
    const { captured, createCalls } = await linked();
    discordOf(captured).onSelfLinked?.();
    captured[0]!.onSelfLinked?.();

    expect(createCalls).toEqual(["abacus_discord", "telegram"]);
    expect(settings.selfBotId).toBe("bot-auto-reply");
    expect(settings.selfBotIds.abacus_discord).toBe("bot-discord");
  });
});

/**
 * WhatsApp's "Message yourself" chat is a self lane like the others: the link
 * proving the user's own number mints its bot and that chat starts answering,
 * with nothing to switch on. It used to ride Telegram's bootstrap bot, so a
 * WhatsApp-only user got no bot at all — and the global switch stays off.
 */
describe("the WhatsApp self-lane bootstrap", () => {
  const reset = (): void => {
    settings.respondToInbound = false;
    settings.botId = null;
    settings.selfBotId = null;
    settings.selfBotIds = {};
    settings.autoReplyBootstrapped = false;
    settings.autoReplyBootstrappedFor = [];
  };

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

  it("gets its own bot even when Telegram already bootstrapped", async () => {
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
