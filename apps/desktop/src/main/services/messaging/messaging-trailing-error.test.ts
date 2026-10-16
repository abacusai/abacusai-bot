import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
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
 * the user's own chat hears one plain line, someone else's chat hears nothing
 * beyond what the agent wrote, and the user's own chat is told who went
 * unanswered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatReplyForFailure,
  FAILURE_REPLY_WINDOW_MS,
} from "./chat-failure-reply";

const mocks = vi.hoisted(() => ({
  account: null as { plan?: string; subscription_tier?: string } | null,
  upgradeLink: vi.fn((_plan: string, _src: string) => UPGRADE_URL),
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
  upgradeLink: (plan: string, src: string) => mocks.upgradeLink(plan, src),
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const UPGRADE_URL = "https://apps.example.test/u/1";
const PLANS_URL = "https://apps.abacus.ai/chatllm/choose-plan/";

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
  mocks.upgradeLink.mockClear();
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

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      created += 1;
      return { id: `session-${created}` } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
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
    gateway.handleAgentEvent(session, { type: "event", event } as never);
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
    fail: (error: Record<string, unknown>) =>
      emit(chatId, { type: "error", error }),
    busy: () => internals.routes.get(`discord:${chatId}`)!.busy,
  });

  const main = chat("C1", "U1", "Ana");
  return {
    log,
    /** The text of everything sent, in order. */
    sent: () => log.map((line) => line.slice(line.indexOf(": ") + 2)),
    ...main,
    chat,
  };
};

/** Let the failure line's upgrade-link fetch settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the user's own chat, on the free plan", () => {
  it("at the credit wall, gets the Basic offer with the account's own link", async () => {
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()).toEqual([
      `I've paused because your free credits have run out. Upgrade to Basic for $7 your first month and I'll pick right back up: ${UPGRADE_URL}`,
    ]);
    expect(mocks.upgradeLink).toHaveBeenCalledWith("basic", "channel");
  });

  it.each([
    ["credit", "Your DeepSeek key is out of credit."],
    ["rate_limit", "Your DeepSeek key hit its rate limit."],
    ["down", "DeepSeek isn't responding right now."],
    ["network", "DeepSeek isn't responding right now."],
  ])(
    "own key failed (%s): says so and offers AbacusAI",
    async (cause, lead) => {
      const h = harness({ self: true });
      await h.inbound("hi");
      h.fail(ownKey(cause));
      await settle();

      expect(h.sent()).toEqual([
        `${lead} Use any model on AbacusAI, $7 your first month: ${UPGRADE_URL}`,
      ]);
    }
  );

  it("free pool used up: the free models are busy, and the Basic offer", async () => {
    const h = harness({ self: true });
    await h.inbound("hi");
    h.fail(POOL_OUT);
    await settle();

    expect(h.sent()).toEqual([
      `The free models are busy right now. Upgrade to Basic for $7 your first month to use the top models: ${UPGRADE_URL}`,
    ]);
  });
});

describe("the user's own chat, on a paid plan", () => {
  beforeEach(() => {
    mocks.account = PAID;
  });

  it("at the credit wall, is told to add credits, no Basic offer", async () => {
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.fail(WALL);
    await settle();

    expect(h.sent()).toEqual([
      `I've paused because this month's credits are used up. Add credits to keep going: ${PLANS_URL}`,
    ]);
    expect(mocks.upgradeLink).not.toHaveBeenCalled();
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

    expect(h.sent()[0]).toContain(`top models: ${UPGRADE_URL}`);
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
  ])("hears nothing about %s", async (_name, error) => {
    for (const account of [FREE, PAID, null]) {
      mocks.account = account;
      const h = harness({ selfId: null });
      await h.inbound("write the report");
      h.fail(error);
      await settle();

      expect(h.log).toEqual([]);
    }
  });

  it("gets only what the agent had produced", async () => {
    const h = harness({ selfId: null });
    await h.inbound("do the thing");
    h.say("Starting…");
    h.fail(WALL);
    await settle();

    expect(h.log).toEqual(["C1: Starting…"]);
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
      `ME: I couldn't reply to Ana just now. I've paused because your free credits have run out. Upgrade to Basic for $7 your first month and I'll pick right back up: ${UPGRADE_URL}`,
    ]);
  });

  it("for anything else, says it plainly", async () => {
    const h = harness();
    await h.inbound("hi");
    h.fail({ message: "boom" });
    await settle();

    expect(h.log).toEqual([
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
      "ME: I couldn't reply to someone just now: something went wrong on my side.",
    ]);
  });

  it("goes to the shared Abacus bot's DM when the account has no own chat", async () => {
    const h = harness({ selfId: null, shared: true });
    await h.inbound("hi");
    h.fail(ownKey("down"));
    await settle();

    expect(h.log).toEqual([
      `shared me: I couldn't reply to Ana just now. DeepSeek isn't responding right now. Use any model on AbacusAI, $7 your first month: ${UPGRADE_URL}`,
    ]);
  });

  it("is not sent, only logged, when there is no own chat at all", async () => {
    const h = harness({ selfId: null });
    await h.inbound("hi");
    h.fail(WALL);
    await settle();

    expect(h.log).toEqual([]);
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
      expect.stringContaining("free credits have run out"),
      expect.stringContaining("free models are busy"),
      expect.stringContaining("Something went wrong"),
      expect.stringContaining("Something went wrong"),
    ]);
  });

  it("one notice per contact per window; the offer inside it shrinks", async () => {
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

    expect(h.log).toEqual([
      expect.stringMatching(
        /^ME: I couldn't reply to Ana just now\. I've paused/
      ),
      `ME: I couldn't reply to Bob just now. Still paused: ${UPGRADE_URL}`,
      expect.stringMatching(
        /^ME: I couldn't reply to Ana just now\. I've paused/
      ),
    ]);
  });
});

describe("the failure line and the end of the turn", () => {
  it("goes once, after the agent's words, without waiting on the network", async () => {
    const h = harness({ self: true });
    await h.inbound("write the report");
    h.say("Working on it");
    h.fail(WALL);
    h.idle();
    await settle();

    expect(h.sent()).toEqual([
      "Working on it",
      expect.stringContaining(UPGRADE_URL),
    ]);
    expect(h.busy()).toBe(false);
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

describe("chatReplyForFailure", () => {
  it("gives someone else's chat nothing, whatever the failure", () => {
    for (const error of [WALL, ownKey("credit"), POOL_OUT, NO_MODEL, {}])
      for (const account of ["free", "paid", "unknown"] as const)
        expect(
          chatReplyForFailure(error, "other", account, UPGRADE_URL)
        ).toBeNull();
  });
});

describe("the credit wall's cause", () => {
  const wall = (cause: string) => ({
    actions: [{ type: "upgrade-abacus", cause }],
  });

  it("an expired free tier is told it expired, with the Basic offer", () => {
    expect(
      chatReplyForFailure(wall("expired"), "own", "free", UPGRADE_URL)
    ).toBe(
      `I've paused because your free credits have expired. Upgrade to Basic for $7 your first month and I'll pick right back up: ${UPGRADE_URL}`
    );
    expect(
      chatReplyForFailure(wall("expired"), "own", "free", UPGRADE_URL, true)
    ).toBe(`Still paused: ${UPGRADE_URL}`);
  });

  it("an empty balance keeps its words", () => {
    expect(
      chatReplyForFailure(wall("exhausted"), "own", "free", UPGRADE_URL)
    ).toBe(chatReplyForFailure(WALL, "own", "free", UPGRADE_URL));
    expect(chatReplyForFailure(wall("exhausted"), "own", "paid", null)).toBe(
      chatReplyForFailure(WALL, "own", "paid", null)
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
    expect(chatReplyForFailure(BUSY, "own", "free", UPGRADE_URL)).toBe(
      `The free models are busy right now. Upgrade to Basic for $7 your first month to use the top models: ${UPGRADE_URL}`
    );
  });

  it("leaves a paid account the plain line", () => {
    expect(chatReplyForFailure(BUSY, "own", "paid", null)).toBe(
      chatReplyForFailure({}, "own", "paid", null)
    );
  });
});
