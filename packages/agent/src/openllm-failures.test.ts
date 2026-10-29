/**
 * How long a failed pool model, or its provider, sits out: read from the
 * provider's own words where it names a wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hostAttached,
  markHostGone,
  setHostConnectivity,
  setReachabilityProbe,
} from "./connectivity.js";
import {
  BusyWait,
  NETWORK_UNREACHABLE_CODE,
  failedCallStreamed,
  NETWORK_WAIT_TURN_MS,
  NETWORK_WAIT_ROUTINE_MS,
  NetworkWait,
  networkEvidence,
  networkWaitBudgetMs,
  runOrigin,
} from "./network-wait.js";
import {
  classifyFailure,
  endedOnLeakedToolCall,
  networkVerdict,
  retryHintMs,
} from "./openllm-failures.js";
import {
  EMPTY_REPLY_FAILURE,
  EMPTY_REPLY_MESSAGE,
  OPENLLM_POOL_BUSY_MESSAGE,
  TurnChain,
  classifyAttempt,
  classifyProviderFailure,
  isBusyCause,
  isContextTooLong,
  presentFailure,
} from "./turn-outcome.js";

const NOON = Date.UTC(2026, 9, 1, 12, 0, 0);

describe("the wait a provider names", () => {
  it.each([
    ["429 Rate limit reached ... Please try again in 7m12.5s.", 432_500],
    ["429 ... Please try again in 450ms.", 5_000],
    ['429 {"error":{"details":[{"retryDelay": "30s"}]}}', 30_000],
    ["429 RESOURCE_EXHAUSTED. Please retry in 23.4s.", 23_400],
    ["503 Service Unavailable. Retry-After: 20", 20_000],
    ["429 Too many requests, retry after 90 seconds", 90_000],
  ])("%s", (failure, ms) => {
    expect(retryHintMs(failure)).toBe(ms);
  });

  it("is absent when none is named", () => {
    expect(retryHintMs("500 Internal Server Error")).toBeNull();
  });
});

describe("what a failure means", () => {
  it("a refused key shuts its provider for the day", () => {
    expect(classifyFailure("401 Invalid API Key", "groq", NOON)).toEqual({
      scope: { provider: "groq" },
      scopeMs: 24 * 3_600_000,
    });
    expect(
      classifyFailure("403 Forbidden: invalid api key", "nvidia", NOON).scope
    ).toEqual({ provider: "nvidia" });
  });

  it("a model removed upstream sits out a day; one off the tier too", () => {
    expect(
      classifyFailure(
        "404 The model `llama3-70b` has been decommissioned",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 24 * 3_600_000 });
    expect(
      classifyFailure(
        "403 Model not available on the free tier",
        "cerebras",
        NOON
      )
    ).toEqual({
      cooldownMs: 24 * 3_600_000,
    });
  });

  it("a model that will not take tools sits out a day", () => {
    expect(
      classifyFailure(
        "400 This model does not support tool calling",
        "nvidia",
        NOON
      )
    ).toEqual({ cooldownMs: 24 * 3_600_000 });
  });

  it("a request that does not fit sits that model out for an hour", () => {
    expect(
      classifyFailure(
        "413 Request too large for model `openai/gpt-oss-120b` ... Limit 8000, Requested 24152",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 3_600_000 });
  });

  it("a spent daily quota waits for UTC midnight unless a wait is named", () => {
    expect(
      classifyFailure(
        "429 Rate limit reached on requests per day (RPD): Limit 1000, Used 1000",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 12 * 3_600_000 });
    expect(
      classifyFailure(
        "429 Rate limit reached on tokens per day (TPD). Please try again in 3m",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 180_000 });
  });

  it("Mistral's one-request-a-second limit holds every model on the key", () => {
    expect(
      classifyFailure(
        "Mistral API error (429): Requests rate limit exceeded",
        "mistral",
        NOON
      )
    ).toEqual({
      scope: { provider: "mistral" },
      scopeMs: 60_000,
    });
  });

  it("keeps the account-wide refusals the pool already knew", () => {
    expect(
      classifyFailure(
        "429 Rate limit exceeded: free-models-per-day",
        "openrouter",
        NOON
      ).scope
    ).toEqual({ provider: "openrouter", free: true });
  });

  it("leaves a plain failure to the usual escalating wait", () => {
    expect(
      classifyFailure("500 Internal Server Error", "nvidia", NOON)
    ).toEqual({});
  });
});

describe("a tool call written as text", () => {
  const assistant = (content: unknown[]) => ({
    role: "assistant",
    stopReason: "stop",
    content,
  });

  it("ends the turn as a failure when the last reply carries one", () => {
    expect(
      endedOnLeakedToolCall([
        assistant([
          { type: "text", text: '<tool_call>{"name":"bash"}</tool_call>' },
        ]),
      ])
    ).toBe("model wrote its tool call as text");
    expect(
      endedOnLeakedToolCall([
        assistant([{ type: "text", text: "[TOOL_CALLS] read" }]),
      ])
    ).not.toBeNull();
  });

  it("is no failure when the call was made, or the reply is prose", () => {
    expect(
      endedOnLeakedToolCall([
        assistant([
          { type: "text", text: "<tool_call>" },
          { type: "toolCall", id: "1", name: "bash", arguments: {} },
        ]),
      ])
    ).toBeNull();
    expect(
      endedOnLeakedToolCall([assistant([{ type: "text", text: "All done." }])])
    ).toBeNull();
    expect(endedOnLeakedToolCall([])).toBeNull();
  });
});

describe("a failure of the network", () => {
  it.each([
    "Connection error.",
    "fetch failed",
    "getaddrinfo ENOTFOUND routellm.abacus.ai",
    "connect ECONNREFUSED 127.0.0.1:443",
    "read ECONNRESET",
    "socket hang up",
    "Request timed out.",
  ])("%s is the network's while the machine is offline", (failure) => {
    expect(networkVerdict(failure, { connectivity: "offline" })).toBe(
      "network"
    );
    expect(
      classifyFailure(failure, "abacus", NOON, { connectivity: "degraded" })
    ).toEqual({ network: true });
  });

  it("asks for a probe when the host thinks the network is fine", () => {
    expect(
      networkVerdict("Request timed out.", { connectivity: "online" })
    ).toBe("unknown");
    expect(
      networkVerdict("Request timed out.", {
        connectivity: "online",
        abacusReachable: false,
      })
    ).toBe("network");
  });

  it("stays the provider's when the Abacus API answers", () => {
    expect(
      classifyFailure("Request timed out.", "abacus", NOON, {
        connectivity: "online",
        abacusReachable: true,
      })
    ).toEqual({});
  });

  it("is never an HTTP answer, a gateway timeout included", () => {
    for (const failure of [
      "504 Gateway Timeout",
      "429 rate limited upstream",
      "502 upstream connect error",
    ])
      expect(networkVerdict(failure, { connectivity: "offline" })).toBe(
        "provider"
      );
  });
});

describe("a busy provider", () => {
  it.each([
    ["429 rate limited upstream", true],
    ["503 Service Unavailable", true],
    ["529 Overloaded", true],
    ["The model is overloaded, try later", true],
    ["429 Rate limit reached for requests per day (RPD)", false],
    ["404 model not found", false],
    ["401 Invalid API Key", false],
  ])("%s busy: %s", (failure, busy) => {
    expect(isBusyCause(failure, "openrouter")).toBe(busy);
  });
});

/** The wait both loops share when the network goes, and when every pool model is busy. */
describe("network and busy waits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setHostConnectivity("unknown");
    setReachabilityProbe(null);
    hostAttached();
    delete process.env.ABACUSAI_BOT_ROUTINE_RUN;
  });

  describe("the wait for the network", () => {
    it("ends the moment the host goes away, and never starts after", async () => {
      const wait = new NetworkWait(() => Date.now());
      const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});
      markHostGone();
      expect(await next).toBe("cancelled");

      const waits: number[] = [];
      expect(
        await wait.next(NETWORK_WAIT_TURN_MS, (_attempt, delay) =>
          waits.push(delay)
        )
      ).toBe("cancelled");
      expect(waits).toEqual([]);

      const busy = new BusyWait();
      expect(await busy.wait(5_000)).toBe(false);
      expect(busy.rounds).toBe(0);
    });

    it("a busy-pool wait ends when the host goes away", async () => {
      const busy = new BusyWait();
      const waited = busy.wait(30_000);
      markHostGone();
      expect(await waited).toBe(false);
    });

    it("backs off 2s, 4s, 8s, 16s, then every 30s", async () => {
      const wait = new NetworkWait(() => Date.now());
      const delays: number[] = [];

      for (let round = 0; round < 7; round++) {
        const next = wait.next(NETWORK_WAIT_TURN_MS, (_attempt, delay) =>
          delays.push(delay)
        );
        await vi.advanceTimersByTimeAsync(delays.at(-1)!);
        expect(await next).toBe("retry");
      }

      expect(delays).toEqual([
        2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
      ]);
    });

    it("retries at once when the host says the network is back", async () => {
      const wait = new NetworkWait(() => Date.now());
      setHostConnectivity("offline");
      for (let round = 0; round < 4; round++) {
        const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});
        await vi.advanceTimersByTimeAsync(16_000);
        await next;
      }

      const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});
      await vi.advanceTimersByTimeAsync(100);
      setHostConnectivity("online");

      expect(await next).toBe("retry");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("retries at once when the machine wakes", async () => {
      const wait = new NetworkWait(() => Date.now());
      setHostConnectivity("offline");
      const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});

      setHostConnectivity("offline", true);

      expect(await next).toBe("retry");
    });

    it("gives up once the budget is spent, and never waits past it", async () => {
      const wait = new NetworkWait(() => Date.now());
      const delays: number[] = [];
      let outcome: string = "retry";

      while (outcome === "retry") {
        const next = wait.next(20_000, (_attempt, delay) => delays.push(delay));
        await vi.advanceTimersByTimeAsync(delays.at(-1) ?? 0);
        outcome = await next;
      }

      expect(outcome).toBe("gave-up");
      // 2 + 4 + 8, then the 6s left of the budget, not a full 16.
      expect(delays).toEqual([2_000, 4_000, 8_000, 6_000]);
    });

    it("ends at once on Stop", async () => {
      const wait = new NetworkWait(() => Date.now());
      const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});

      wait.cancel();

      expect(await next).toBe("cancelled");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("starts afresh after a reset", async () => {
      const wait = new NetworkWait(() => Date.now());
      const delays: number[] = [];
      const first = wait.next(NETWORK_WAIT_TURN_MS, (_a, d) => delays.push(d));
      await vi.advanceTimersByTimeAsync(2_000);
      await first;

      wait.reset();
      const second = wait.next(NETWORK_WAIT_TURN_MS, (_a, d) => delays.push(d));
      await vi.advanceTimersByTimeAsync(2_000);
      await second;

      expect(delays).toEqual([2_000, 2_000]);
    });
  });

  describe("the budget", () => {
    it("is ten minutes for a turn a person sent and an hour for a routine's run", () => {
      expect(runOrigin()).toBe("turn");
      expect(networkWaitBudgetMs()).toBe(10 * 60_000);
      expect(NETWORK_WAIT_TURN_MS).toBe(10 * 60_000);

      process.env.ABACUSAI_BOT_ROUTINE_RUN = "1";
      expect(runOrigin()).toBe("routine");
      expect(networkWaitBudgetMs()).toBe(60 * 60_000);
      expect(NETWORK_WAIT_ROUTINE_MS).toBe(60 * 60_000);
    });
  });

  describe("the evidence for a failure", () => {
    it("takes the host's word without probing when it knows", async () => {
      const probe = vi.fn(async () => true);
      setReachabilityProbe(probe);
      setHostConnectivity("offline");

      expect(await networkEvidence("Request timed out.")).toEqual({
        connectivity: "offline",
      });
      expect(probe).not.toHaveBeenCalled();
    });

    it("probes the Abacus API when the host thinks all is well", async () => {
      setReachabilityProbe(async () => false);
      setHostConnectivity("online");

      expect(await networkEvidence("Request timed out.")).toEqual({
        connectivity: "online",
        abacusReachable: false,
      });
    });

    it("never probes for a failure that is not network-shaped", async () => {
      const probe = vi.fn(async () => false);
      setReachabilityProbe(probe);

      await networkEvidence("429 rate limited upstream");

      expect(probe).not.toHaveBeenCalled();
    });
  });

  describe("whether the failed call had started answering", () => {
    it("reads the failed message's own content", () => {
      expect(
        failedCallStreamed([
          { role: "user", content: "hi" },
          { role: "assistant", stopReason: "error", content: [] },
        ])
      ).toBe(false);
      expect(
        failedCallStreamed([
          {
            role: "assistant",
            stopReason: "error",
            content: [{ type: "text", text: "Here is" }],
          },
        ])
      ).toBe(true);
    });
  });

  describe("the wait for a busy pool", () => {
    it("waits for the soonest model, at most a minute a round, three rounds", async () => {
      const wait = new BusyWait();
      const delays: number[] = [];

      for (const readyIn of [15_000, 300_000, 300_000, 300_000]) {
        if (!wait.available) break;
        delays.push(wait.delayFor(readyIn));
        const next = wait.wait(readyIn);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await next).toBe(true);
      }

      expect(delays).toEqual([15_000, 60_000, 60_000]);
      expect(wait.available).toBe(false);
      expect(await wait.wait(1_000)).toBe(false);
    });

    it("ends at once on Stop", async () => {
      const wait = new BusyWait();
      const next = wait.wait(60_000);

      wait.cancel();

      expect(await next).toBe(false);
    });
  });
});

describe("one cause per turn, read from the whole chain of calls", () => {
  const route = {
    routed: true,
    freeLaneProviders: ["openrouter", "gemini"],
    onFreeLane: false,
    abacusFreeModels: [],
    abacus: null,
  };

  // Each from a real turn's log: what the call said, and what it means.
  it.each([
    [
      "abacus",
      "429: You have no remaining credits to use the LLM apis.",
      "credits_exhausted",
    ],
    [
      "abacus",
      "429: Your free AbacusAI credits have expired, so you have no remaining credits to use the API.",
      "credits_expired",
    ],
    ["openrouter", "Connection error.", "connection"],
    ["gemini", "fetch failed", "connection"],
    ["openrouter", "Request timed out.", "connection"],
    ["openrouter", "read ECONNRESET", "connection"],
    ["openrouter", "getaddrinfo ENOTFOUND openrouter.ai", "connection"],
    [
      "openrouter",
      "400 Please reduce the length of the messages or completion.",
      "context_too_long",
    ],
    [
      "groq",
      "413 Request too large for model on tokens per minute (TPM)",
      "context_too_long",
    ],
    ["openrouter", "400 failed to template request", "model_unavailable"],
    ["openrouter", "404 No endpoints found for big:free.", "model_unavailable"],
    ["mistral", "401 Unauthorized", "key_invalid"],
    ["nvidia", "429 Too Many Requests", "rate_limited"],
    ["openrouter", "503 Service Unavailable", "rate_limited"],
    [
      "gemini",
      '429 {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
      "own_key_quota",
    ],
    [
      "openrouter",
      "429: Rate limit exceeded: free-models-per-day.",
      "own_key_quota",
    ],
    [
      "nvidia",
      "429 You have exceeded your daily request limit (requests per day).",
      "own_key_quota",
    ],
  ] as const)("%s: %s → %s", (provider, raw, cause) => {
    expect(classifyAttempt(raw, provider)).toBe(cause);
  });

  it("a connection error after a rate limit is the connection's, never busy", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed("Connection error.", "gemini");
    expect(chain.failure()).toMatchObject({
      cause: "connection",
      provider: "gemini",
    });
  });

  it("says busy only when every failed call was a real rate limit", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed("503 Service Unavailable", "gemini");
    const failure = chain.failure()!;
    expect(failure.cause).toBe("rate_limited");
    expect(presentFailure(failure, route).message).toBe(
      OPENLLM_POOL_BUSY_MESSAGE
    );
  });

  it("a too-long chat outranks a busy model, and offers a new chat", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed("400 Please reduce the length of the messages.", "gemini");
    const shown = presentFailure(chain.failure()!, route);
    expect(shown.cause).toBe("context_too_long");
    expect(shown.actions).toEqual([
      { type: "new-chat" },
      { type: "switch-model" },
    ]);
  });

  it("an empty reply after a failure is a failure, not a silent end", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed(EMPTY_REPLY_FAILURE, "gemini");
    expect(chain.failure()?.cause).toBe("rate_limited");
    const lone = new TurnChain();
    lone.failed(EMPTY_REPLY_FAILURE, "gemini");
    expect(presentFailure(lone.failure()!, route)).toMatchObject({
      cause: "empty",
      message: EMPTY_REPLY_MESSAGE,
      actions: [{ type: "retry" }, { type: "switch-model" }],
    });
  });

  it("a call that answered last ends the turn with nothing to report", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.answered("gemini");
    expect(chain.failure()).toBeNull();
  });

  it("the credit wall outranks everything and offers the free lane by name", () => {
    const chain = new TurnChain();
    chain.failed(
      "429: You have no remaining credits to use the LLM apis.",
      "abacus"
    );
    const shown = presentFailure(chain.failure()!, route);
    expect(shown).toMatchObject({
      cause: "credits_exhausted",
      code: "turn_failed",
    });
    expect(shown.actions).toEqual([
      { type: "upgrade-abacus", cause: "exhausted" },
      { type: "continue-free", providers: ["openrouter", "gemini"] },
    ]);
    // No plans page in the words: the card carries the account's own link.
    expect(JSON.stringify(shown)).not.toMatch(/https?:/);
  });

  it("offers no free lane when no hosted free source is connected", () => {
    const shown = presentFailure(
      {
        cause: "credits_exhausted",
        provider: "abacus",
        raw: "429: no remaining credits",
      },
      { ...route, freeLaneProviders: [] }
    );
    expect(shown.actions).toEqual([
      { type: "upgrade-abacus", cause: "exhausted" },
    ]);
  });

  it("a pinned Abacus model at the wall keeps its own $0 models by name", () => {
    const shown = presentFailure(
      {
        cause: "credits_exhausted",
        provider: "abacus",
        raw: "429: You have no remaining credits to use the LLM apis.",
      },
      {
        routed: false,
        freeLaneProviders: ["gemini"],
        onFreeLane: false,
        abacusFreeModels: [{ model: "abacus/free-1", label: "Free One" }],
        abacus: "out",
      }
    );
    expect(shown.actions).toEqual([
      { type: "upgrade-abacus", cause: "exhausted" },
      { type: "switch-model", model: "abacus/free-1", label: "Free One" },
    ]);
    expect(shown.message).toBe(
      "You're out of credits (429). Upgrade your plan to keep going, or switch to a model with its own key."
    );
  });

  it("a connection failure ends on the connection card", () => {
    const shown = presentFailure(
      { cause: "connection", provider: "openrouter", raw: "Connection error." },
      route
    );
    expect(shown).toMatchObject({
      code: NETWORK_UNREACHABLE_CODE,
      cause: "connection",
      message:
        "Connection problem — check your internet connection, VPN, or proxy.",
      detail: "Connection error.",
      actions: [{ type: "retry" }],
    });
  });

  it("a failed turn on the chosen free lane comes back to the wall's card, not a busy loop", () => {
    const shown = presentFailure(
      {
        cause: "rate_limited",
        provider: "openrouter",
        raw: "429 Too Many Requests",
      },
      { ...route, onFreeLane: true }
    );
    expect(shown.cause).toBe("rate_limited");
    expect(shown.actions?.[0]).toEqual({
      type: "upgrade-abacus",
      cause: "exhausted",
    });
  });

  it("a refused own key names its provider with a way to fix it", () => {
    const shown = presentFailure(
      { cause: "key_invalid", provider: "mistral", raw: "401 Unauthorized" },
      route
    );
    expect(shown.actions).toEqual([
      { type: "fix-key", provider: "mistral" },
      { type: "switch-model" },
    ]);
  });
});

/**
 * Who refused decides. Real answers from turns that showed the Abacus
 * out-of-credits card while the provider refusing was the user's own key,
 * and Abacus's own refusals with and without the code the server now adds.
 */
describe("who refused: Abacus's wall, its billing gate, or the user's own key", () => {
  const pinned = (abacus: "credits" | "out" | null) => ({
    routed: false,
    freeLaneProviders: [],
    onFreeLane: false,
    abacusFreeModels: [],
    abacus,
  });
  const GEMINI_QUOTA =
    '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 429,\\n    \\"message\\": \\"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://…';
  const OPENAI_NO_CREDITS =
    "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";
  const DEEPSEEK_BALANCE =
    "402: Insufficient Balance (request_id: 00000000-0000-0000-0000-000000000000)";
  const HUGGINGFACE_CREDITS =
    '402 "You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get monthly included credits."';
  const PAYMENT_UNCONFIRMED =
    '402 "We could not confirm the last payment on this subscription. If your subscription is active, please contact support@abacus.ai - do not purchase again."';
  const ABACUS_WALL = "429: You have no remaining credits to use the LLM apis.";
  const ABACUS_WALL_CODED =
    '429: {"message":"You have no remaining credits to use the LLM apis.","type":"insufficient_quota","param":null,"code":"insufficient_quota","abacus_error_code":"abacus_credits_exhausted"}';

  it.each([
    ["gemini", GEMINI_QUOTA, "own_key_quota"],
    ["openai", OPENAI_NO_CREDITS, "own_key_quota"],
    ["deepseek", DEEPSEEK_BALANCE, "own_key_quota"],
    ["huggingface", HUGGINGFACE_CREDITS, "own_key_quota"],
    [
      "openrouter",
      "402: Insufficient credits. Add more using https://openrouter.ai/settings/credits",
      "own_key_quota",
    ],
    [
      "minimax",
      '402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"}}',
      "own_key_quota",
    ],
    ["cerebras", "402 status code (no body)", "own_key_quota"],
    [
      "opencode",
      "402: Upstream request failed: Insufficient account funds",
      "own_key_quota",
    ],
    // A server's own "no remaining credits" is not Abacus's wall either.
    ["local", ABACUS_WALL, "rate_limited"],
    // Abacus without the code (today's server): read by its words.
    ["abacus", ABACUS_WALL, "credits_exhausted"],
    ["abacus", PAYMENT_UNCONFIRMED, "payment_required"],
    [
      "abacus",
      '402 "Your subscription has ended. Please renew it to continue."',
      "payment_required",
    ],
    [
      "abacus",
      '402 "Your free trial has ended. Please subscribe to continue."',
      "credits_expired",
    ],
    // Abacus with the code: the code decides.
    ["abacus", ABACUS_WALL_CODED, "credits_exhausted"],
    [
      "abacus",
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Your free AbacusAI credits have expired. You have no remaining credits to use the API.","abacus_error_code":"abacus_free_tier_expired"}}',
      "credits_expired",
    ],
    [
      "abacus",
      '402 {"success":false,"error":"We could not confirm the last payment on this subscription.","errorType":"PaymentMethodRequired","reason":"unconfirmed","abacusErrorCode":"abacus_payment_required"}',
      "payment_required",
    ],
  ] as const)("%s: %s → %s", (provider, raw, cause) => {
    expect(classifyAttempt(raw, provider)).toBe(cause);
  });

  it("an own key's quota names that key, never the Abacus credits", () => {
    for (const [provider, raw] of [
      ["gemini", GEMINI_QUOTA],
      ["openai", OPENAI_NO_CREDITS],
      ["deepseek", DEEPSEEK_BALANCE],
      ["huggingface", HUGGINGFACE_CREDITS],
    ] as const) {
      const chain = new TurnChain();
      chain.failed(raw, provider);
      const shown = presentFailure(chain.failure()!, pinned("credits"));
      expect(shown.cause).toBe("own_key_quota");
      expect(shown.message).toMatch(/^Your .+ key hit its quota\./);
      expect(shown.message).not.toMatch(/out of credits|Abacus/i);
      expect(shown.actions).toEqual([
        { type: "fix-key", provider },
        { type: "switch-to-abacus" },
      ]);
    }
  });

  it("an own key's quota while the Abacus credits are out too offers the plan", () => {
    const shown = presentFailure(
      { cause: "own_key_quota", provider: "deepseek", raw: DEEPSEEK_BALANCE },
      pinned("out")
    );
    expect(shown.actions).toEqual([
      { type: "fix-key", provider: "deepseek" },
      { type: "upgrade-abacus", cause: "exhausted" },
    ]);
  });

  it("Abacus's billing gate is a payment card, never the credits card", () => {
    const chain = new TurnChain();
    chain.failed(PAYMENT_UNCONFIRMED, "abacus");
    const shown = presentFailure(chain.failure()!, pinned("credits"));
    expect(shown).toMatchObject({
      cause: "payment_required",
      message:
        "We couldn't confirm your last payment. If your subscription is active, contact support@abacus.ai. Please don't purchase again.",
      actions: [
        { type: "payment-required", cause: "unconfirmed" },
        { type: "switch-model" },
      ],
    });
    expect(JSON.stringify(shown.actions)).not.toContain("upgrade-abacus");
    const lapsed = presentFailure(
      {
        cause: "payment_required",
        provider: "abacus",
        raw: '402 "Your subscription has ended. Please renew it to continue."',
      },
      pinned("credits")
    );
    expect(lapsed.actions?.[0]).toEqual({
      type: "payment-required",
      cause: "lapsed",
    });
  });

  it("Abacus's wall, coded or not, is still the credits card", () => {
    for (const raw of [ABACUS_WALL, ABACUS_WALL_CODED]) {
      const shown = presentFailure(
        { cause: classifyAttempt(raw, "abacus"), provider: "abacus", raw },
        pinned("out")
      );
      expect(shown.cause).toBe("credits_exhausted");
      expect(shown.actions?.[0]).toEqual({
        type: "upgrade-abacus",
        cause: "exhausted",
      });
      expect(shown.message).toMatch(/^You're out of credits \(429\)\./);
    }
  });

  it("the summary is the provider's quota for an own key, the wall for Abacus", () => {
    expect(classifyProviderFailure(DEEPSEEK_BALANCE, "deepseek").summary).toBe(
      "The model provider is out of quota"
    );
    expect(classifyProviderFailure(ABACUS_WALL, "abacus").summary).toBe(
      "You're out of credits"
    );
    // No provider known: read as before.
    expect(classifyProviderFailure(ABACUS_WALL).summary).toBe(
      "You're out of credits"
    );
  });
});

describe("free credits held until the account verifies a phone", () => {
  const VERIFY =
    '429: {"message":"Verify your phone to unlock 2,000 free credits: https://apps.abacus.ai/bot/link/verify-phone","type":"insufficient_quota","param":null,"code":"insufficient_quota","abacus_error_code":"abacus_credits_not_activated"}';
  const pinned = {
    routed: false,
    freeLaneProviders: ["gemini", "openrouter"],
    onFreeLane: false,
    abacusFreeModels: [{ model: "abacus/free-1", label: "Free One" }],
    abacus: "out" as const,
  };

  it("is its own cause, read from the code, and only from Abacus", () => {
    expect(classifyAttempt(VERIFY, "abacus")).toBe("phone_verification");
    expect(classifyAttempt(VERIFY, "gemini")).not.toBe("phone_verification");
  });

  it("offers the verify page and nothing else: no plan, no other model, no free lane", () => {
    for (const context of [pinned, { ...pinned, routed: true }]) {
      const chain = new TurnChain();
      chain.failed("429 Too Many Requests", "openrouter");
      chain.failed(VERIFY, "abacus");
      const shown = presentFailure(chain.failure()!, context);
      expect(shown.cause).toBe("phone_verification");
      expect(shown.actions).toEqual([
        {
          type: "verify-phone",
          link: "https://apps.abacus.ai/bot/link/verify-phone",
          credits: "2,000",
        },
      ]);
      expect(shown.message).toBe(
        "Verify your phone to unlock 2,000 free credits. Verify it once at https://apps.abacus.ai/bot/link/verify-phone, then send your message again."
      );
    }
    // Chosen free lane or not, the wall's card never stands in for it.
    const lane = presentFailure(
      { cause: "phone_verification", provider: "abacus", raw: VERIFY },
      { ...pinned, routed: true, onFreeLane: true }
    );
    expect(lane.actions?.[0]?.type).toBe("verify-phone");
  });

  it("takes the page from the refusal, but only an Abacus page", () => {
    const at = (url: string) =>
      presentFailure(
        {
          cause: "phone_verification",
          provider: "abacus",
          raw: VERIFY.replace(
            "https://apps.abacus.ai/bot/link/verify-phone",
            url
          ),
        },
        pinned
      ).actions?.[0]?.link;
    expect(at("https://staging-apps.abacus.ai/bot/link/verify-phone")).toBe(
      "https://staging-apps.abacus.ai/bot/link/verify-phone"
    );
    expect(at("https://example.test/verify-phone")).toBe(
      "https://apps.abacus.ai/bot/link/verify-phone"
    );
    const bare = presentFailure(
      {
        cause: "phone_verification",
        provider: "abacus",
        raw: '429: {"message":"Free credits are on hold.","abacus_error_code":"abacus_credits_not_activated"}',
      },
      pinned
    );
    expect(bare.actions).toEqual([
      {
        type: "verify-phone",
        link: "https://apps.abacus.ai/bot/link/verify-phone",
      },
    ]);
  });

  it("is never waited out as a busy provider", () => {
    expect(isBusyCause(VERIFY, "abacus")).toBe(false);
  });
});

/**
 * What compaction answers. A request refused for its size is one of them: the
 * transcript it carries is what makes it too big, and without a compaction
 * every later turn sends the same bytes and is refused the same way.
 */
describe("a transcript that no longer fits", () => {
  it.each([
    ["400 This model's maximum context length is 131072 tokens.", true],
    ['413 "Maximum request body size 67108864 exceeded."', true],
    ["413 Request Entity Too Large", true],
    ['{"error":{"code":413,"message":"Payload Too Large"}}', true],
    ["429 Too Many Requests", false],
    ["You have no remaining credits to use the LLM apis.", false],
    ["500 Internal Server Error", false],
  ] as const)("%s → %s", (raw, fits) => {
    expect(isContextTooLong(raw)).toBe(fits);
  });
});
