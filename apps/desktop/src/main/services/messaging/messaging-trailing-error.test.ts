/**
 * What a chat is told when the agent reports an error.
 *
 * Not every provider failure lands mid-turn. The agent reads the failure off
 * pi's state once `prompt()` has resolved, which is after the turn's idle
 * event, so an error can arrive at a route that has already flushed its reply
 * and gone free. Forwarding one sent a second chat message holding nothing but
 * raw provider text ("Provider finish_reason: MALFORMED_FUNCTION_CALL"), about
 * a turn that had in fact just answered the question correctly.
 *
 * Mid-turn, the raw error went out too: provider JSON and the credit wall's
 * "429: … no remaining credits" reached phones, and other people's chats. Now
 * the user's own chat hears one plain line, someone else's chat hears one
 * neutral line and nothing about why, and the user's own chat is told who went
 * unanswered, with the whole line every time.
 *
 * A turn never ends on silence: one that said nothing, or that the app ended
 * itself (the inactivity watchdog, the agent going away), still ends on a line.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TurnLedger } from "../session/turn-ledger";
import { channelLocale, channelWords } from "./channel-words";
import {
  chatFailureOf,
  chatReplyForFailure,
  FAILURE_REPLY_WINDOW_MS,
  type ChannelOffer,
} from "./chat-failure-reply";

const mocks = vi.hoisted(() => ({
  account: null as { plan?: string; subscription_tier?: string } | null,
  fetchUpgradeUrl: null as unknown as () => Promise<string | null>,
  billing: null as unknown,
  language: null as string | null,
}));

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: "ws",
      autoReplyPausedUntil: 0,
    }),
    isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
    isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
    approvedUserIds: () => new Set(["U1", "U2", "U3"]),
    findPairing: () => null,
    recordPairingRequest: () => {},
    listPairing: () => [],
  };
});

vi.mock("../providers/abacus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/abacus")>();
  return { ...actual, cachedAbacusAccount: () => mocks.account };
});

vi.mock("../providers/abacus-upgrade", () => ({
  fetchUpgradeUrl: () => mocks.fetchUpgradeUrl(),
  fetchBillingPlan: async () => mocks.billing,
  botUpgradePage: () => BOT_UPGRADE_URL,
}));

vi.mock("@abacus-ai/agent/user-language", () => ({
  readUserLanguage: () =>
    mocks.language == null ? null : { name: mocks.language, source: "user" },
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { gatewayTurns } = await import("./messaging-turns.test-support");

const UPGRADE_URL = "https://apps.example.test/u/1";
const BOT_UPGRADE_URL =
  "https://apps.example.test/bot/link/upgrade?src=channel";
const TOP_UP_URL = "https://apps.example.test/top-up";

/** The plan as the platform's billing call answers it. */
const BILLING: BillingPlan = {
  current: {
    planName: "Free",
    creditsRemaining: 0,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "free",
      planName: "Free",
      priceText: "Free",
      features: [],
      creditsPerMonth: 2000,
      current: true,
    },
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [
        "Unlimited chatting with the bot (20,000 credits a month)",
        "Top models including Model A, Model B, Model C, Model D and Model E",
      ],
      creditsPerMonth: 20000,
      current: false,
    },
  ],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [
        "Unlimited chatting with the bot (20,000 credits a month)",
        "Top models including Model A, Model B, Model C, Model D and Model E",
      ],
      url: null,
    },
  ],
  topUpUrl: TOP_UP_URL,
  upgradeInMobileApp: false,
};

/** The Basic offer, as the chat app hears it, in English. */
/** The plan's whole pitch, as every upgrade line carries it. */
const PITCH = [
  "- 20,000 credits a month (10x the free plan)",
  "- Top models: Model A, Model B, Model C, Model D",
  "- Image and video generation",
  "- Personal agents in Abacus AI Agent on the web that run 24/7, even with your computer off: WhatsApp, Discord and Telegram auto-replies, all your routines, and everything your bot does",
  "- 100+ connectors: Gmail, Google Calendar, Slack, Drive, Notion and more",
  "- Build and deploy powerful apps on the web, including mobile apps",
];
const offerLines = (link: string) =>
  [
    "Basic is $7 your first month, then $10/month and gives you:",
    ...PITCH,
    `Upgrade here: ${link}`,
  ].join("\n");
const wallLine = (link: string) =>
  ["I've paused because your free credits are used up.", offerLines(link)].join(
    "\n"
  );

const FREE = { subscription_tier: "free" };
const PAID = { subscription_tier: "basic" };

const WALL = {
  message:
    '429: {"message":"You have no remaining credits to use the LLM apis"}',
  actions: [{ type: "upgrade-abacus" }],
};
const ownKey = (cause: string) => ({
  message: '402: {"error":{"message":"Insufficient balance"}}',
  actions: [{ type: "own-key-unavailable", provider: "deepseek", cause }],
});
const POOL_OUT = {
  message: "Every free model is used up for now.",
  code: "model_unavailable",
  actions: [{ type: "free-pool-out" }, { type: "switch-model" }],
};
const NO_MODEL = {
  message:
    "No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /Users/x/.abacusai-bot/profiles/p/agent/docs/providers.md",
  code: "model_unavailable",
};

beforeEach(() => {
  mocks.account = FREE;
  mocks.fetchUpgradeUrl = async () => UPGRADE_URL;
  mocks.billing = BILLING;
  mocks.language = null;
});

/**
 * One Discord chat with sender `U1`. `self`: that sender is the account the
 * connector is signed in as, so the chat is the user's own. Otherwise the
 * own chat is `ME`, or absent with `selfId: null`; `shared` adds the shared
 * Abacus bot's DM as the user's own chat.
 */
const harness = ({
  self = false,
  selfId = "ME" as string | null,
  shared = false,
  clock = { now: 0 },
}: {
  self?: boolean;
  selfId?: string | null;
  shared?: boolean;
  clock?: { now: number };
} = {}) => {
  /** Everything sent, as `chatId: text`. */
  const log: string[] = [];
  const sessions = new Map<string, string>();
  let created = 0;

  const turns = gatewayTurns(() => gateway);
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      created += 1;
      return { id: `session-${created}` } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (_w: string, s: string) => turns.sent(s),
    emitUserMessage: () => {},
    emitChanged: () => {},
    now: () => clock.now,
  } as never);

  const connectors = (
    gateway as unknown as { connectors: Map<string, unknown> }
  ).connectors;
  connectors.set("discord", {
    id: "discord",
    start: async () => {},
    stop: async () => {},
    sendText: async (chatId: string, text: string) => {
      log.push(`${chatId}: ${text}`);
    },
    selfChatId: () => (self ? "U1" : selfId),
  });
  if (shared)
    connectors.set("abacus_discord", {
      id: "abacus_discord",
      start: async () => {},
      stop: async () => {},
      sendText: async (chatId: string, text: string) => {
        log.push(`shared ${chatId}: ${text}`);
      },
      selfChatId: () => "me",
    });

  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
    routes: Map<string, { sessionId: string; busy: boolean }>;
  };

  const emit = (chatId: string, event: Record<string, unknown>): void => {
    const session = sessions.get(chatId);
    if (session == null) throw new Error(`no turn in ${chatId}`);
    turns.emit(session, event);
  };

  const chat = (chatId: string, userId: string, userName: string | null) => ({
    inbound: async (text: string) => {
      await internals.handleInbound("discord", {
        userId,
        userName,
        chatId,
        text,
      });
      sessions.set(
        chatId,
        internals.routes.get(`discord:${chatId}`)!.sessionId
      );
    },
    say: (content: string) => emit(chatId, { type: "text_delta", content }),
    idle: () =>
      emit(chatId, { type: "status_changed", status: AgentStatus.Idle }),
    /** A failed turn as the agent ends one: the error, then its close. */
    fail: (error: Record<string, unknown>) => {
      emit(chatId, { type: "error", error });
      emit(chatId, {
        type: "turn_complete",
        outcome: { kind: "failed", cause: error.cause ?? error.code },
      });
      emit(chatId, { type: "status_changed", status: AgentStatus.Idle });
    },
    busy: () => internals.routes.get(`discord:${chatId}`)!.busy,
  });

  const main = chat("C1", "U1", "Ana");
  return {
    gateway,
    turns,
    clock,
    sessionOf: (chatId: string) => sessions.get(chatId)!,
    log,
    /** The text of everything sent, in order. */
    sent: () => log.map((line) => line.slice(line.indexOf(": ") + 2)),
    ...main,
    chat,
  };
};

/** Let the failure line's upgrade-link fetch settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const NEUTRAL = "Sorry, I can't reply right now. I'll get back to you soon.";

describe("the user's own chat, on the free plan", () => {
  it("at the credit wall, gets the Basic offer with the account's own link", async () => {
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()).toEqual([wallLine(UPGRADE_URL)]);
    // Never the raw refusal.
    expect(h.sent()[0]).not.toMatch(/429|no remaining credits/);
  });

  it("falls back to the bot's upgrade page when there is no upgrade link", async () => {
    mocks.fetchUpgradeUrl = async () => null;
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()[0]).toContain(`Upgrade here: ${BOT_UPGRADE_URL}`);
  });

  it("falls back to the bot's upgrade page when the link fetch throws", async () => {
    mocks.fetchUpgradeUrl = async () => {
      throw new Error("offline");
    };
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()).toHaveLength(1);
    expect(h.sent()[0]).toContain(BOT_UPGRADE_URL);
    expect(h.sent()[0]).not.toContain("choose-plan");
  });

  it("without the billing plan, still says what stopped, with the link", async () => {
    mocks.billing = null;
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()).toEqual([
      `I've paused because your free credits are used up.\nUpgrade here: ${UPGRADE_URL}`,
    ]);
  });

  it.each([
    ["credit", "Your DeepSeek key is out of credit."],
    ["rate_limit", "Your DeepSeek key hit its rate limit."],
    ["down", "DeepSeek isn't responding right now."],
    ["network", "DeepSeek isn't responding right now."],
  ])(
    "own key failed (%s): says so and points at the Abacus credits, no half pitch",
    async (cause, lead) => {
      const h = harness({ self: true });
      await h.inbound("hi");
      h.fail(ownKey(cause));
      await settle();

      expect(h.sent()).toEqual([
        `${lead} Switch to Abacus.AI in the app's model picker to keep going on your free Abacus credits.`,
      ]);
    }
  );

  it("free pool used up: the free models are busy, and the Basic offer", async () => {
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail(POOL_OUT);
    await settle();

    expect(h.sent()).toEqual([
      `The free models are busy right now.\n${offerLines(UPGRADE_URL)}`,
    ]);
  });
});

describe("the user's own chat, on a paid plan", () => {
  beforeEach(() => {
    mocks.account = PAID;
    mocks.fetchUpgradeUrl = vi.fn(async () => UPGRADE_URL);
  });

  it("at the credit wall, is told to add credits, no Basic offer", async () => {
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()).toEqual([
      `I've paused because this month's credits are used up. Add credits to keep going: ${TOP_UP_URL}`,
    ]);
    expect(mocks.fetchUpgradeUrl).not.toHaveBeenCalled();
  });

  it("own key failed: points at AbacusAI Agent on the web", async () => {
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail(ownKey("rate_limit"));
    await settle();

    expect(h.sent()).toEqual([
      "Your DeepSeek key hit its rate limit. Use it in AbacusAI Agent on the web: https://apps.abacus.ai/chatllm",
    ]);
  });

  it("an account never read words the wall like a paid one", async () => {
    mocks.account = null;
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()[0]).toContain("this month's credits are used up");
  });

  it("an account never read still gets the free-pool offer", async () => {
    mocks.account = null;
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail(POOL_OUT);
    await settle();

    expect(h.sent()[0]).toContain(`Upgrade here: ${UPGRADE_URL}`);
  });
});

describe("the user's own chat, any plan", () => {
  it("not signed in: the sign-in line, not what pi said", async () => {
    const h = harness({ self: true });
    await h.inbound("Hey");
    h.fail(NO_MODEL);
    await settle();

    expect(h.sent()).toHaveLength(1);
    expect(h.sent()[0]).toContain("not signed in to Abacus.AI");
    expect(h.sent()[0]).not.toContain("/login");
    expect(h.sent()[0]).not.toContain("providers.md");
  });

  it("anything else: one plain line after what the agent had produced", async () => {
    const h = harness({ self: true });
    await h.inbound("do the thing");
    h.say("Starting…");
    h.fail({ message: '500: {"error":"upstream"}' });
    await settle();

    expect(h.sent()).toEqual([
      "Starting…",
      "Something went wrong on my side, so I couldn't finish that. Please try again in a moment.",
    ]);
  });

  it("Abacus's billing gate: support and the billing page, never a purchase", async () => {
    mocks.fetchUpgradeUrl = vi.fn(async () => UPGRADE_URL);
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail({
      message: "We couldn't confirm your last payment.",
      code: "turn_failed",
      cause: "payment_required",
      actions: [
        { type: "payment-required", cause: "unconfirmed" },
        { type: "switch-model" },
      ],
    });
    await settle();

    expect(h.sent()).toEqual([
      "I've paused because we couldn't confirm your last payment. If your subscription is active, contact support@abacus.ai, and please don't purchase again. Billing: https://apps.abacus.ai/chatllm/admin/profile",
    ]);
    expect(mocks.fetchUpgradeUrl).not.toHaveBeenCalled();
  });

  it("free credits held for a phone check: the verify page, no plan, in one line", async () => {
    mocks.fetchUpgradeUrl = vi.fn(async () => UPGRADE_URL);
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail({
      message: "Verify your phone to unlock 2,000 free credits.",
      code: "turn_failed",
      cause: "phone_verification",
      actions: [
        {
          type: "verify-phone",
          link: "https://apps.abacus.ai/bot/link/verify-phone",
          credits: "2,000",
        },
      ],
    });
    await settle();

    expect(h.sent()).toEqual([
      "Verify your phone to unlock 2,000 free credits: https://apps.abacus.ai/bot/link/verify-phone",
    ]);
    expect(mocks.fetchUpgradeUrl).not.toHaveBeenCalled();
  });

  it("a lapsed subscription is asked to renew", async () => {
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail({
      message: "Your Abacus.AI subscription has ended.",
      code: "turn_failed",
      cause: "payment_required",
      actions: [{ type: "payment-required", cause: "lapsed" }],
    });
    await settle();

    expect(h.sent()).toEqual([
      "I've paused because your Abacus.AI subscription has ended. Renew it here: https://apps.abacus.ai/chatllm/admin/profile",
    ]);
  });

  it("raw credit-wall text without the action is just a failure", async () => {
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail({ message: WALL.message });
    await settle();

    expect(h.sent()).toEqual([
      "Something went wrong on my side, so I couldn't finish that. Please try again in a moment.",
    ]);
  });
});

describe("someone else's chat", () => {
  it.each([
    ["the credit wall", WALL],
    ["an own-key failure", ownKey("credit")],
    ["the free pool", POOL_OUT],
    ["no model", NO_MODEL],
    ["anything else", { message: "402: out of credit" }],
  ])(
    "hears one neutral line about %s, and nothing of why",
    async (_name, error) => {
      for (const account of [FREE, PAID, null]) {
        mocks.account = account;
        const h = harness({ selfId: null });
        await h.inbound("write the report");
        h.fail(error);
        await settle();

        expect(h.log).toEqual([`C1: ${NEUTRAL}`]);
      }
    }
  );

  it("gets what the agent had produced, then the neutral line", async () => {
    const h = harness({ selfId: null });
    await h.inbound("do the thing");
    h.say("Starting…");
    h.fail(WALL);
    await settle();

    expect(h.log).toEqual(["C1: Starting…", `C1: ${NEUTRAL}`]);
  });
});

describe("the notice in the user's own chat", () => {
  it("says who went unanswered, with the own-chat line", async () => {
    const h = harness();
    await h.inbound("write the report");
    h.say("On it");
    h.fail(WALL);
    await settle();

    expect(h.log).toEqual([
      "C1: On it",
      `C1: ${NEUTRAL}`,
      `ME: I couldn't reply to Ana just now. ${wallLine(UPGRADE_URL)}`,
    ]);
  });

  it("for anything else, says it plainly", async () => {
    const h = harness();
    await h.inbound("hi");
    h.fail({ message: "boom" });
    await settle();

    expect(h.log).toEqual([
      `C1: ${NEUTRAL}`,
      "ME: I couldn't reply to Ana just now: something went wrong on my side.",
    ]);
  });

  it("names nobody when the sender has no name", async () => {
    const h = harness();
    const bob = h.chat("C2", "U2", null);
    await bob.inbound("hi");
    bob.fail({ message: "boom" });
    await settle();

    expect(h.log).toEqual([
      `C2: ${NEUTRAL}`,
      "ME: I couldn't reply to someone just now: something went wrong on my side.",
    ]);
  });

  it("goes to the shared Abacus bot's DM when the account has no own chat", async () => {
    const h = harness({ selfId: null, shared: true });
    await h.inbound("hi");
    h.fail(ownKey("down"));
    await settle();

    expect(h.log).toEqual([
      `C1: ${NEUTRAL}`,
      "shared me: I couldn't reply to Ana just now. DeepSeek isn't responding right now. Switch to Abacus.AI in the app's model picker to keep going on your free Abacus credits.",
    ]);
  });

  it("is not sent, only logged, when there is no own chat at all", async () => {
    const h = harness({ selfId: null });
    await h.inbound("hi");
    h.fail(WALL);
    await settle();

    expect(h.log).toEqual([`C1: ${NEUTRAL}`]);
  });
});

describe("the six-hour throttle", () => {
  it("the own chat hears the offer once, then a short reminder, then the offer again", async () => {
    const clock = { now: 0 };
    const h = harness({ self: true, clock });
    for (const at of [0, 60_000, FAILURE_REPLY_WINDOW_MS + 1]) {
      clock.now = at;
      await h.inbound("again");
      h.fail(WALL);
      await settle();
      h.idle();
    }

    expect(h.sent()).toEqual([
      expect.stringContaining("$7 your first month"),
      `Still paused: ${UPGRADE_URL}`,
      expect.stringContaining("$7 your first month"),
    ]);
  });

  it("a paid own key's repeat keeps only what happened", async () => {
    mocks.account = PAID;
    const h = harness({ self: true });
    for (let i = 0; i < 2; i += 1) {
      await h.inbound("again");
      h.fail(ownKey("credit"));
      await settle();
      h.idle();
    }

    expect(h.sent()).toEqual([
      "Your DeepSeek key is out of credit. Use it in AbacusAI Agent on the web: https://apps.abacus.ai/chatllm",
      "Your DeepSeek key is out of credit.",
    ]);
  });

  it("each kind of failure is throttled on its own, plain lines never", async () => {
    const h = harness({ self: true });
    for (const error of [WALL, POOL_OUT, { message: "x" }, { message: "x" }]) {
      await h.inbound("again");
      h.fail(error);
      await settle();
      h.idle();
    }

    expect(h.sent()).toEqual([
      expect.stringContaining("free credits are used up"),
      expect.stringContaining("free models are busy"),
      expect.stringContaining("Something went wrong"),
      expect.stringContaining("Something went wrong"),
    ]);
  });

  it("a contact that went unanswered is told every time, with the whole line", async () => {
    const clock = { now: 0 };
    const h = harness({ clock });
    const bob = h.chat("C2", "U2", "Bob");

    for (const [who, at] of [
      [h, 0],
      [h, 1_000],
      [bob, 2_000],
      [h, FAILURE_REPLY_WINDOW_MS + 1],
    ] as const) {
      clock.now = at;
      await who.inbound("hi");
      who.fail(WALL);
      await settle();
      who.idle();
    }

    const full = (name: string) =>
      `ME: I couldn't reply to ${name} just now. ${wallLine(UPGRADE_URL)}`;
    expect(h.log).toEqual([
      `C1: ${NEUTRAL}`,
      full("Ana"),
      `C1: ${NEUTRAL}`,
      full("Ana"),
      `C2: ${NEUTRAL}`,
      full("Bob"),
      `C1: ${NEUTRAL}`,
      full("Ana"),
    ]);
  });
});

describe("the failure line and the end of the turn", () => {
  it("goes once, after the agent's words, and the turn ends only then", async () => {
    let release: (url: string) => void = () => {};
    mocks.fetchUpgradeUrl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.say("Working on it");
    h.fail(WALL);
    h.idle();
    await settle();

    // The idle came first; the route waits on the line before going free.
    expect(h.sent()).toEqual(["Working on it"]);
    expect(h.busy()).toBe(true);

    release(UPGRADE_URL);
    await settle();

    expect(h.sent()).toEqual([
      "Working on it",
      expect.stringContaining(UPGRADE_URL),
    ]);
    expect(h.busy()).toBe(false);
  });
});

describe("an upgrade link that never comes", () => {
  it("is given up on: the bot's upgrade page goes instead and the turn ends", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchUpgradeUrl = () => new Promise(() => {});
      const h = harness({ self: true });
      await h.inbound("write the report");
      h.fail(WALL);
      h.idle();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(h.sent()).toEqual([expect.stringContaining(BOT_UPGRADE_URL)]);
      expect(h.busy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a turn that ends without a word", () => {
  it("the user's own chat hears that no reply came, once", async () => {
    const h = harness({ self: true });
    await h.inbound("hello?");
    h.idle();
    await settle();

    expect(h.sent()).toEqual([
      "I couldn't put a reply together for that. Please send it again.",
    ]);
    expect(h.busy()).toBe(false);
  });

  it("a contact hears nothing; the user is told and decides", async () => {
    const h = harness();
    await h.inbound("are you there?");
    h.idle();
    await settle();

    expect(h.log).toEqual([
      "ME: I didn't reply to Ana: no answer came back. Open the app to answer them, or tell me what to say.",
    ]);
  });

  it("a deliberate NO_REPLY is a decision, not a silent turn", async () => {
    const h = harness();
    await h.inbound("ok 👍");
    h.say("NO_REPLY");
    h.idle();
    await settle();

    expect(h.log).toEqual([]);
  });
});

describe("a turn the app ended itself", () => {
  /** Main ends the turn (the watchdog, the agent's exit, a Stop) in the ledger. */
  const close = (
    h: ReturnType<typeof harness>,
    kind: "timed_out" | "agent_exited" | "stopped"
  ) => h.turns.ledger.end(h.sessionOf("C1"), kind);

  it("the watchdog's timeout reaches the chat and frees it", async () => {
    const h = harness({ self: true });
    await h.inbound("build the site");
    h.say("Working on it");
    close(h, "timed_out");
    await settle();

    expect(h.sent()).toEqual([
      "Working on it",
      "That took too long and was stopped before I could reply. Send it again to pick it back up.",
    ]);
    expect(h.busy()).toBe(false);
  });

  it("an agent that went away is said too; a contact gets the neutral line", async () => {
    const h = harness();
    await h.inbound("hi");
    close(h, "agent_exited");
    await settle();

    expect(h.log).toEqual([
      `C1: ${NEUTRAL}`,
      "ME: I couldn't reply to Ana just now. The app stopped before I could reply. Send it again to pick it back up.",
    ]);
  });

  it("a Stop in the app frees the chat without a word", async () => {
    const h = harness({ self: true });
    await h.inbound("long job");
    close(h, "stopped");
    await settle();

    expect(h.sent()).toEqual([]);
    expect(h.busy()).toBe(false);
  });

  it("an ending after the agent's own idle changes nothing", async () => {
    const h = harness({ self: true });
    await h.inbound("hi");
    h.say("Hello!");
    h.idle();
    close(h, "timed_out");
    await settle();

    expect(h.sent()).toEqual(["Hello!"]);
  });
});

describe("a turn the app closed under, found on the next start", () => {
  /** The last run journaled an open turn for this chat; this start recovers it. */
  const recovered = (
    h: ReturnType<typeof harness>,
    channel: { chatId: string; owner: boolean }
  ) => {
    const journal = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turn-journal-")),
      "turns-open.json"
    );
    const before = new TurnLedger({ journal: () => journal });
    before.annotate("session-old", {
      platform: "discord",
      userName: "Ana",
      ...channel,
    });
    before.begin("session-old");
    const after = new TurnLedger({ journal: () => journal });
    after.onClose((record) => h.gateway.noteTurnClosed(record));
    after.recover();
    return journal;
  };
  const flush = (h: ReturnType<typeof harness>) =>
    (
      h.gateway as unknown as { outbox: { flush(): Promise<void> } }
    ).outbox.flush();

  it("the user's own chat hears it once its platform is up", async () => {
    const h = harness({ self: true });
    recovered(h, { chatId: "U1", owner: true });
    await flush(h);
    await flush(h);

    expect(h.log).toEqual([
      "U1: The app closed before I could reply. Send it again to pick it back up.",
    ]);
  });

  it("a contact hears the neutral line, and the user who went unanswered", async () => {
    const h = harness();
    recovered(h, { chatId: "C1", owner: false });
    await flush(h);

    expect(h.log).toEqual([
      `C1: ${NEUTRAL}`,
      "ME: I couldn't reply to Ana just now. The app closed before I could reply. Send it again to pick it back up.",
    ]);
  });

  it("a close replayed after a crash owes the chat nothing twice", async () => {
    const h = harness({ self: true });
    const journal = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turn-journal-")),
      "turns-open.json"
    );
    const before = new TurnLedger({ journal: () => journal });
    before.annotate("session-old", {
      platform: "discord",
      chatId: "U1",
      owner: true,
      userName: "Ana",
    });
    before.begin("session-old");
    const leftOpen = fs.readFileSync(journal, "utf8");
    const start = () => {
      const ledger = new TurnLedger({ journal: () => journal });
      ledger.onClose((record) => h.gateway.noteTurnClosed(record));
      ledger.recover();
    };
    start();
    await flush(h);
    // A crash before the journal's rewrite: the next start finds it again.
    fs.writeFileSync(journal, leftOpen);
    start();
    await flush(h);

    expect(h.log).toEqual([
      "U1: The app closed before I could reply. Send it again to pick it back up.",
    ]);
  });
});

describe("a long turn", () => {
  it("tells the user's own chat it is still working, every ten minutes, and stops once it answers", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ self: true });
      await h.inbound("build the whole site");
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(h.sent()).toEqual([]);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.sent()).toEqual([
        "Still working on it (10 min so far). I'll reply here when it's done.",
        "Still working on it (20 min so far). I'll reply here when it's done.",
      ]);

      h.say("Done: the site is up.");
      h.idle();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(h.sent().at(-1)).toBe("Done: the site is up.");
      expect(h.sent()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends a progress note into a contact's chat", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.inbound("can you send me the file?");
      await vi.advanceTimersByTimeAsync(25 * 60_000);
      expect(h.log).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a note that fails to send is dropped, never kept to retry", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ self: true });
      const connector = (
        h.gateway as unknown as {
          connectors: Map<string, { sendText: unknown }>;
        }
      ).connectors.get("discord")!;
      const send = connector.sendText as (
        c: string,
        t: string
      ) => Promise<void>;
      let down = true;
      connector.sendText = async (chatId: string, text: string) => {
        if (down) throw new Error("offline");
        return send(chatId, text);
      };
      await h.inbound("build the whole site");
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      down = false;
      h.say("Done.");
      h.idle();
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(h.sent()).toEqual(["Done."]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an error that arrives after the turn ended", () => {
  it("does not send the raw provider text as its own message", async () => {
    const h = harness({ self: true });
    await h.inbound("what is 78999 * 35678?");
    h.say("The result of 78999 * 35678 is 2818526322.");
    h.idle();

    h.fail({ message: "Provider finish_reason: MALFORMED_FUNCTION_CALL" });
    await settle();

    // The regression: two messages, the second one just the provider string.
    expect(h.sent()).toEqual(["The result of 78999 * 35678 is 2818526322."]);
  });

  it("sends nothing at all, not even the credit wall's offer or a notice", async () => {
    const h = harness();
    await h.inbound("hello");
    h.say("Hi!");
    h.idle();
    h.fail(WALL);
    await settle();

    expect(h.log).toEqual(["C1: Hi!"]);
  });
});

const ENGLISH = await channelWords("en-US");
const OFFER: ChannelOffer = {
  upgradeUrl: UPGRADE_URL,
  topUpUrl: TOP_UP_URL,
  billing: BILLING,
};
const reply = (
  error: Parameters<typeof chatReplyForFailure>[0],
  account: "free" | "paid" | "unknown",
  repeat = false
) => chatReplyForFailure(error, "own", account, ENGLISH, OFFER, repeat);

describe("a credit milestone crossed in a chat-app turn", () => {
  const mark = (patch: Partial<CreditThresholdMark> = {}) =>
    ({
      reached: 50,
      at: 0,
      used: 1000,
      granted: 2000,
      perTask: 80,
      kind: "messages",
      told: null,
      ...patch,
    }) as CreditThresholdMark;

  it("the user's own chat hears the card's words and the upgrade link, no keyword to reply", async () => {
    const h = harness({ self: true });
    await h.inbound("plan my week");
    h.say("Done.");
    h.idle();
    expect(await h.gateway.tellCreditThreshold(h.sessionOf("C1"), mark())).toBe(
      true
    );
    expect(h.sent()).toEqual([
      "Done.",
      [
        "You've used half your free credits",
        "You have 1,000 of 2,000 left.",
        "That's about 12 more bot messages like today's.",
        // The plan's whole pitch, as every upgrade line carries it.
        offerLines(UPGRADE_URL),
      ].join("\n"),
    ]);
  });

  it("at four fifths urges the upgrade, without an estimate it cannot make", async () => {
    const h = harness({ self: true });
    await h.inbound("plan my week");
    h.say("Done.");
    h.idle();
    await h.gateway.tellCreditThreshold(
      h.sessionOf("C1"),
      mark({ reached: 80, used: 1640, perTask: null, kind: null })
    );
    expect(h.sent().at(-1)).toBe(
      [
        "Only 360 free credits left",
        "Upgrade now so your work doesn't stop halfway.",
        offerLines(UPGRADE_URL),
      ].join("\n")
    );
  });

  it("a contact's chat never hears it; the user's own chat does", async () => {
    const h = harness();
    await h.inbound("hi");
    h.say("Hi!");
    h.idle();
    await h.gateway.tellCreditThreshold(h.sessionOf("C1"), mark());
    expect(h.log).toEqual([
      "C1: Hi!",
      expect.stringMatching(/^ME: You've used half your free credits\n/),
    ]);
  });

  it("a turn that was not a chat app's says nothing there", async () => {
    const h = harness({ self: true });
    expect(await h.gateway.tellCreditThreshold("session-x", mark())).toBe(
      false
    );
    await h.inbound("plan my week");
    h.say("Done.");
    h.idle();
    h.clock.now += 10 * 60_000;
    expect(await h.gateway.tellCreditThreshold(h.sessionOf("C1"), mark())).toBe(
      false
    );
    expect(h.sent()).toEqual(["Done."]);
  });

  it("is worded in the user's language, plural and all", async () => {
    mocks.language = "portuguese";
    const h = harness({ self: true });
    await h.inbound("oi");
    h.say("Pronto.");
    h.idle();
    await h.gateway.tellCreditThreshold(
      h.sessionOf("C1"),
      mark({ perTask: 1000, kind: "builds" })
    );
    const line = h.sent().at(-1)!;
    expect(line).toMatch(
      /^Você usou metade dos seus créditos grátis\nRestam 1\.000 de 2\.000\.\nDá para cerca de 1 build a mais como os de hoje\.\n/
    );
    expect(line).toContain("- Geração de imagens e vídeos");
    expect(line.endsWith(`Faça upgrade aqui: ${UPGRADE_URL}`)).toBe(true);
  });
});

describe("the success pitch in a chat app", () => {
  it("the user's own chat hears it after the reply: glad it worked, the plan's whole pitch, the link, once", async () => {
    const h = harness({ self: true });
    await h.inbound("thanks!");
    h.say("You're welcome!");
    h.idle();
    expect(await h.gateway.tellSuccessPitch(h.sessionOf("C1"))).toBe(true);
    expect(h.sent()).toEqual([
      "You're welcome!",
      [
        "Glad that worked for you.",
        offerLines(UPGRADE_URL),
        "I won't bring this up again here.",
      ].join("\n"),
    ]);
  });

  it("a turn that was not a chat app's, or long over, says nothing there", async () => {
    const h = harness({ self: true });
    expect(await h.gateway.tellSuccessPitch("session-x")).toBe(false);
    await h.inbound("thanks!");
    h.say("Anytime.");
    h.idle();
    h.clock.now += 10 * 60_000;
    expect(await h.gateway.tellSuccessPitch(h.sessionOf("C1"))).toBe(false);
    expect(h.sent()).toEqual(["Anytime."]);
  });

  it("is worded in the user's language", async () => {
    mocks.language = "portuguese";
    const h = harness({ self: true });
    await h.inbound("valeu!");
    h.say("De nada!");
    h.idle();
    await h.gateway.tellSuccessPitch(h.sessionOf("C1"));
    const line = h.sent().at(-1)!;
    expect(line.startsWith("Que bom que deu certo.\n")).toBe(true);
    expect(line).toContain("- Geração de imagens e vídeos");
    expect(line.endsWith("Não vou mais falar disso por aqui.")).toBe(true);
  });
});

describe("chatReplyForFailure", () => {
  it("gives someone else's chat nothing, whatever the failure", () => {
    for (const error of [WALL, ownKey("credit"), POOL_OUT, NO_MODEL, {}])
      for (const account of ["free", "paid", "unknown"] as const)
        expect(
          chatReplyForFailure(error, "other", account, ENGLISH, OFFER)
        ).toBeNull();
  });

  it("a refused own key names whose key, with where to fix it, never the raw error", () => {
    expect(
      reply(
        {
          cause: "key_invalid",
          actions: [
            { type: "fix-key", provider: "openai" },
            { type: "switch-to-abacus" },
          ],
        },
        "free"
      )
    ).toBe(
      "Your OpenAI key was rejected — it's invalid or expired. Fix it in the app under Settings → Models."
    );
  });

  it("a dropped connection says so, never busy", () => {
    expect(reply({ code: "network_unreachable" }, "free")).toBe(
      "The connection dropped, so I couldn't finish that. Please try again in a moment."
    );
  });
});

describe("the credit wall's cause", () => {
  const wall = (cause: string) => ({
    actions: [{ type: "upgrade-abacus", cause }],
  });

  it("an expired free tier is told it expired, with the Basic offer", () => {
    expect(reply(wall("expired"), "free")).toBe(
      `I've paused because your free credits have expired.\n${offerLines(UPGRADE_URL)}`
    );
    expect(reply(wall("expired"), "free", true)).toBe(
      `Still paused: ${UPGRADE_URL}`
    );
  });

  it("an empty balance keeps its words", () => {
    expect(reply(wall("exhausted"), "free")).toBe(reply(WALL, "free"));
    expect(reply(wall("exhausted"), "paid")).toBe(reply(WALL, "paid"));
  });
});

describe("a paid plan out of credits", () => {
  const BASIC: BillingPlan = {
    ...BILLING,
    current: { ...BILLING.current, plan: "basic", planName: "Basic" },
    upgrades: [
      {
        plan: "pro",
        planName: "Pro",
        priceText: "$20/mo",
        firstMonthPriceCents: 2000,
        priceCents: 2000,
        features: ["Everything in Basic"],
        url: "https://apps.example.test/plans",
      },
    ],
  };
  const paid = (billing: BillingPlan, repeat = false) =>
    chatReplyForFailure(
      { actions: [{ type: "upgrade-abacus", cause: "exhausted" }] },
      "own",
      "paid",
      ENGLISH,
      { ...OFFER, billing },
      repeat
    );

  it("is told to add credits, then offered the next plan with its price and link", () => {
    expect(paid(BASIC)).toBe(
      `I've paused because this month's credits are used up. Add credits to keep going: ${TOP_UP_URL}\nOr move up to Pro ($20/month) for more credits every month: https://apps.example.test/plans`
    );
    expect(paid(BASIC, true)).toBe(`Still paused: ${TOP_UP_URL}`);
  });

  it("a plan billed by the app store is sent to the mobile app, with no link", () => {
    const store: BillingPlan = {
      ...BASIC,
      upgrades: BASIC.upgrades.map((tier) => ({ ...tier, url: null })),
      topUpUrl: null,
      upgradeInMobileApp: true,
    };
    for (const repeat of [false, true])
      expect(paid(store, repeat)).toBe(
        "This month's credits are used up. Your plan is billed through the App Store or Google Play, so add credits or upgrade in the Abacus.AI mobile app."
      );
  });
});

describe("a picked model that cannot serve the turn", () => {
  const gone = (cause: string, out = false) => ({
    cause: "model_unavailable",
    actions: [
      {
        type: "model-unavailable",
        cause,
        model: "abacus/s5",
        label: "Sonnet 5",
      },
      out
        ? { type: "upgrade-abacus", cause: "exhausted" }
        : { type: "switch-to-abacus" },
    ],
  });

  it("with credits left, names the model and points to RouteLLM - Open in the app", () => {
    const line =
      "Sonnet 5 isn't available anymore, so I couldn't finish that. Your message is kept: switch to RouteLLM - Open in the app's model picker to keep going.";
    expect(reply(gone("retired"), "free")).toBe(line);
    expect(reply(gone("retired"), "paid")).toBe(line);
    // No reply keyword, and no pause: the credits are fine.
    expect(line).not.toMatch(/reply|paused/i);
    expect(reply(gone("down"), "free")).toContain("isn't available right now");
  });

  it("with the credits used up, offers the plan from billing_plan", () => {
    expect(reply(gone("retired", true), "free")).toBe(
      `Sonnet 5 isn't available, and your Abacus credits are used up.\n${offerLines(UPGRADE_URL)}`
    );
    expect(reply(gone("retired", true), "free", true)).toBe(
      `Still paused: ${UPGRADE_URL}`
    );
  });

  it("a model the plan does not include leads with RouteLLM - Open, then the plan", () => {
    expect(reply(gone("plan"), "free")).toBe(
      `Sonnet 5 isn't included in your plan. Switch to RouteLLM - Open in the app's model picker to keep going, or upgrade to use it.\n${offerLines(UPGRADE_URL)}`
    );
    expect(reply(gone("plan"), "free", true)).toBe(
      "Sonnet 5 isn't included in your plan. Switch to RouteLLM - Open in the app's model picker to keep going, or upgrade to use it."
    );
  });
});

describe("a busy free pool", () => {
  const BUSY = {
    actions: [
      { type: "free-pool-out", cause: "busy" },
      { type: "switch-model" },
    ],
  };

  it("offers a free account Basic rather than a retry", () => {
    expect(reply(BUSY, "free")).toBe(
      `The free models are busy right now.\n${offerLines(UPGRADE_URL)}`
    );
  });

  it("leaves a paid account the plain line", () => {
    expect(reply(BUSY, "paid")).toBe(reply({}, "paid"));
  });
});

describe("the chat app's own language", () => {
  it("picks the stored language, then the app's, then English", () => {
    expect(channelLocale("Portuguese", "en-US")).toBe("pt-BR");
    expect(channelLocale("Turkish", null)).toBe("tr-TR");
    expect(channelLocale("Klingon", "es-MX")).toBe("es-419");
    expect(channelLocale(null, "fr-CA")).toBe("fr-FR");
    expect(channelLocale("Klingon", "xx-YY")).toBe("en-US");
    expect(channelLocale(null, null)).toBe("en-US");
  });

  it("labels the native menus in the UI language, English until one loads", async () => {
    const { nativeT, setNativeLanguage } =
      await import("../config/native-language");
    expect(nativeT("cut")).toBe("Cut");
    expect(nativeT("aboutApp", { app: "AbacusAI Bot" })).toBe(
      "About AbacusAI Bot"
    );
    expect(await setNativeLanguage("de-DE")).toBe(true);
    expect(nativeT("cut")).toBe("Ausschneiden");
    expect(await setNativeLanguage("de-DE")).toBe(false);
    expect(await setNativeLanguage("tr-TR")).toBe(true);
    expect(nativeT("quitApp", { app: "AbacusAI Bot" })).toBe(
      "AbacusAI Bot Uygulamasından Çık"
    );
    await setNativeLanguage("en-US");
  });

  it("is never Hindi: a Hindi language or app falls back to English", () => {
    expect(channelLocale("Hindi", "hi-IN")).toBe("en-US");
    expect(channelLocale(null, "hi-IN")).toBe("en-US");
    expect(channelLocale("Hindi", "tr-TR")).toBe("tr-TR");
  });

  it("a Portuguese user hears the wall in Portuguese, with the bot's link and the plan's price", async () => {
    mocks.language = "Portuguese";
    mocks.fetchUpgradeUrl = async () => null;
    const h = harness({ self: true });
    await h.inbound("escreva o relatório");
    h.fail(WALL);
    // The locale file loads on first use.
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1), {
      // A cold locale import on a loaded CI runner takes seconds.
      timeout: 15_000,
    });
    const line = h.sent()[0]!;
    expect(line).toContain("Pausei porque seus créditos grátis acabaram.");
    expect(line).not.toMatch(/renov/i);
    expect(line).toContain("- Geração de imagens e vídeos");
    expect(line).toMatch(
      /O Basic custa US\$\s?7 no primeiro mês, depois US\$\s?10\/mês/
    );
    expect(line).toContain(`Faça upgrade aqui: ${BOT_UPGRADE_URL}`);
    expect(line).not.toMatch(/\$7 your first month|I've paused/);
  });

  it("a Turkish user hears the wall in Turkish", async () => {
    mocks.language = "Turkish";
    const h = harness({ self: true });
    await h.inbound("raporu yaz");
    h.fail(WALL);
    await vi.waitFor(() => expect(h.sent()).toHaveLength(1), {
      // A cold locale import on a loaded CI runner takes seconds.
      timeout: 15_000,
    });

    expect(h.sent()[0]).toContain(
      "Ücretsiz kredilerin bittiği için durakladım."
    );
    expect(h.sent()[0]).toContain(`Buradan yükselt: ${UPGRADE_URL}`);
  });

  it("a language the app does not ship falls back to English cleanly", async () => {
    mocks.language = "Klingon";
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail(WALL);
    await settle();

    expect(h.sent()).toEqual([wallLine(UPGRADE_URL)]);
  });

  it("a key a locale lacks reads in English", async () => {
    const words = await channelWords("tr-TR");
    expect(words.t("outcome.channel.nope")).toBe("outcome.channel.nope");
    expect(words.t("outcome.channel.generic")).not.toBe(
      ENGLISH.t("outcome.channel.generic")
    );
  });
});

describe("what a closed turn owes its chat", () => {
  it("nothing for a reply that reached it, or a Stop", () => {
    expect(chatFailureOf({ kind: "reply" }, true)).toBeNull();
    expect(chatFailureOf({ kind: "stopped" }, false)).toBeNull();
  });

  it("the empty line for a turn that reached it with nothing", () => {
    expect(chatFailureOf({ kind: "reply" }, false)).toEqual({ cause: "empty" });
    expect(
      chatFailureOf(
        { kind: "failed", cause: "empty", error: { cause: "empty" } },
        false
      )
    ).toEqual({ cause: "empty" });
  });

  it("no empty line once the agent's own send has answered the chat", () => {
    expect(
      chatFailureOf(
        { kind: "failed", cause: "empty", error: { cause: "empty" } },
        true
      )
    ).toBeNull();
  });

  it("the reported error's code, cause and actions for a failure", () => {
    expect(
      chatFailureOf(
        {
          kind: "failed",
          cause: "credits_exhausted",
          error: {
            code: "turn_failed",
            cause: "credits_exhausted",
            actions: [{ type: "upgrade-abacus" }],
          },
        },
        true
      )
    ).toEqual({
      code: "turn_failed",
      cause: "credits_exhausted",
      actions: [{ type: "upgrade-abacus" }],
    });
  });

  it("main's own endings by their kind", () => {
    expect(chatFailureOf({ kind: "timed_out" }, false)).toEqual({
      code: "timed_out",
    });
    expect(chatFailureOf({ kind: "agent_exited" }, true)).toEqual({
      code: "agent_exited",
    });
  });
});
