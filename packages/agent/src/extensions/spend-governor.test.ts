import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The spend governor: one owner of what a turn may spend. Calls, time and
 * credits all close out the same way, with a line naming the limit; near the
 * end of the credits the model hears the balance and keeps working; the
 * context ceiling follows who pays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { noteBilledCredits } from "../abacus-credits.js";
import { HostCore } from "../agui/queue.js";
import { hostCreditBalance, setCreditRefresher } from "../credit-balance.js";
import type { SpendKind, SpendLane } from "../spend-policy.js";
import {
  reservePrompt,
  SpendGovernor,
  type SpendLimitHit,
  spendStopReason,
  summaryModelFor,
} from "./spend-governor.js";

const core = new HostCore({} as never, () => {});
// Each read is newer than the last, as the host's are.
let stamp = Date.now();
const balance = (
  remaining: number,
  granted = 2000,
  planCredits?: number,
  paid = false
) =>
  core.handle({
    type: "credit_balance",
    remaining,
    granted,
    at: ++stamp,
    ...(planCredits != null ? { planCredits } : {}),
    ...(paid ? { paid: true } : {}),
  });

const billedModel = {
  provider: "abacus",
  id: "premium-model",
  contextWindow: 1_000_000,
};
const ctxOn = (
  model: Record<string, unknown> | undefined,
  aborts?: number[]
) => ({
  cwd: process.cwd(),
  hasUI: false,
  ui: { notify() {} },
  abort() {
    aborts?.push(1);
  },
  model,
});
const billed = ctxOn(billedModel);

const governed = (
  kind: SpendKind = "attended",
  lane: SpendLane = "abacus-billed"
) => {
  const pi = fakePi();
  const hits: SpendLimitHit[] = [];
  const lows: number[] = [];
  const governor = new SpendGovernor({
    kind,
    laneOf: (model) =>
      model == null || model.provider !== "abacus" ? "own-key" : lane,
    onCloseOut: (hit) => hits.push(hit),
    onCreditsLow: (left) => lows.push(left),
  });
  governor.extension(pi.api as never);
  return { pi, governor, hits, lows };
};

const closeOuts = (pi: ReturnType<typeof fakePi>) =>
  pi.messages.filter((m) => m.customType === "abacusai-bot-close-out");

describe("a run that runs long", () => {
  afterEach(() => {
    delete process.env.ABACUSAI_BOT_TURN_CAP;
  });

  const run = async (cap: number, turns: number) => {
    process.env.ABACUSAI_BOT_TURN_CAP = String(cap);
    const { pi, hits, governor } = governed("attended", "own-key");
    const aborts: number[] = [];
    const ctx = ctxOn(undefined, aborts);
    await pi.fire("agent_start", {});
    for (let i = 0; i < turns; i++) await pi.fire("turn_start", {}, ctx);
    const steers = pi.messages
      .filter((m) => m.customType === "calite-budget")
      .map((m) => String(m.content));
    return { pi, aborts, steers, hits, governor };
  };

  it("asks it to wrap up and present what it has, 100 calls short of the cap", async () => {
    const { steers, aborts } = await run(250, 150);

    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("150 of 250");
    expect(steers[0]).toContain("present_deliverable");
    expect(aborts).toEqual([]);
  });

  it("warns again, harder, 50 short, and keeps them in order on a tiny cap", async () => {
    expect((await run(250, 200)).steers[1]).toContain("Final warning");
    const tiny = await run(40, 40);
    expect(tiny.steers).toHaveLength(1);
    expect(tiny.steers[0]).toContain("Final warning");
  });

  it("closes out past the cap with one visible line naming it, instead of cutting the run mid-step", async () => {
    const { pi, aborts, hits, governor } = await run(250, 251);

    expect(aborts).toEqual([]);
    expect(closeOuts(pi)).toEqual([
      expect.objectContaining({
        display: false,
        content: expect.stringContaining("closing message"),
      }),
    ]);
    expect(hits).toEqual([{ cause: "calls", amount: 250 }]);
    expect(governor.closing()).toBe(true);
    expect(
      await pi.fire("tool_call", {
        toolName: "bash",
        toolCallId: "c",
        input: { command: "ls" },
      })
    ).toMatchObject({ block: true });
    for (const toolName of ["agent-tools_present_deliverable", "send_media"])
      expect(
        await pi.fire("tool_call", { toolName, toolCallId: "p", input: {} })
      ).toBeUndefined();
    expect(spendStopReason()).toBeNull();
  });

  it("stops a run that has not closed out a few calls later, in the user's words", async () => {
    const { aborts, pi } = await run(250, 254);

    expect(aborts).toHaveLength(1);
    const reason = spendStopReason() ?? "";
    expect(reason).toContain("250 model calls");
    expect(reason).not.toMatch(/provider/i);
    await pi.fire("agent_start", {});
    expect(spendStopReason()).toBeNull();
  });

  it("keeps the hour and the close-out across a hidden continuation of the same turn", async () => {
    vi.useFakeTimers();
    try {
      const { pi } = governed("attended", "own-key");
      const aborts: number[] = [];
      const ctx = ctxOn(undefined, aborts);
      await pi.fire("input", { text: "build it", source: "interactive" });
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      vi.advanceTimersByTime(40 * 60_000);
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      vi.advanceTimersByTime(20 * 60_000);
      await pi.fire("turn_start", {}, ctx);
      expect(closeOuts(pi)).toHaveLength(1);
      expect(String(closeOuts(pi)[0]?.content)).toContain("60 minutes");
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      await pi.fire("turn_start", {}, ctx);
      expect(aborts).toEqual([]);
      await pi.fire("turn_start", {}, ctx);
      expect(aborts).toHaveLength(1);
      // The user's next message is a new turn: a new hour.
      await pi.fire("input", { text: "go on", source: "interactive" });
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      expect(closeOuts(pi)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a phone chat half an hour and a routine 150 calls", async () => {
    vi.useFakeTimers();
    try {
      const phone = governed("phone", "own-key");
      await phone.pi.fire("agent_start", {});
      vi.advanceTimersByTime(30 * 60_000);
      await phone.pi.fire("turn_start", {}, ctxOn(undefined));
      expect(phone.hits).toEqual([{ cause: "time", amount: 30 }]);
    } finally {
      vi.useRealTimers();
    }
    const routine = governed("routine", "own-key");
    await routine.pi.fire("agent_start", {});
    for (let i = 0; i < 151; i++)
      await routine.pi.fire("turn_start", {}, ctxOn(undefined));
    expect(routine.hits).toEqual([{ cause: "calls", amount: 150 }]);
  });
});

describe("work nobody asked for", () => {
  it("closes out the verify loop's follow-up at its own call limit", async () => {
    const { pi, governor, hits } = governed("attended", "own-key");
    await pi.fire("agent_start", {});
    governor.beginUnasked(3);
    for (let i = 0; i < 3; i++)
      await pi.fire("turn_start", {}, ctxOn(undefined));
    // Closed out unseen: the verify loop says its own line, as before.
    expect(governor.closing()).toBe(true);
    expect(hits).toEqual([]);
    expect(governor.endUnasked()).toBe(true);
  });

  it("closes it out on credits too: a tenth of the turn, at least 10", async () => {
    await balance(2000, 3000);
    const { pi, governor, hits } = governed("attended");
    await pi.fire("input", { text: "build", source: "interactive" });
    await pi.fire("agent_start", {});
    await pi.fire("turn_start", {}, billed);
    noteBilledCredits(40);
    governor.beginUnasked(50);
    await pi.fire("turn_start", {}, billed);
    noteBilledCredits(11);
    await pi.fire("turn_start", {}, billed);
    expect(governor.closing()).toBe(true);
    expect(hits).toEqual([]);
    expect(governor.endUnasked()).toBe(true);
  });
});

describe("a routine run's credits", () => {
  it("never close it out: the user set it going, so it finishes", async () => {
    await balance(2000, 3000);
    const { pi, governor, hits } = governed("routine");
    const aborts: number[] = [];
    const ctx = ctxOn(billedModel, aborts);
    await pi.fire("input", { text: "Run the check", source: "interactive" });
    await pi.fire("agent_start", {});
    // Ten credits a request, well past any share of the plan.
    for (let i = 0; i < 60; i++) {
      await pi.fire("turn_start", {}, ctx);
      noteBilledCredits(10);
    }
    expect(hits).toEqual([]);
    expect(governor.closing()).toBe(false);
    expect(aborts).toHaveLength(0);
    expect(spendStopReason()).toBeNull();
  });

  it("never applies to a run off Abacus credits", async () => {
    await balance(2000, 3000);
    const { pi, hits } = governed("routine", "pool");
    await pi.fire("agent_start", {});
    noteBilledCredits(500);
    await pi.fire("turn_start", {}, ctxOn({ provider: "groq", id: "x" }));
    expect(hits).toEqual([]);
  });
});

describe("a chat the user is in has no per-turn credit stop", () => {
  it("keeps working past any share of the credits, on a free or a paid plan", async () => {
    for (const read of [
      () => balance(100, 100),
      () => balance(10_000, 20_000, 20_000, true),
    ]) {
      await read();
      const { pi, hits } = governed("attended");
      await pi.fire("input", { text: "build", source: "interactive" });
      await pi.fire("agent_start", {});
      noteBilledCredits(90);
      await pi.fire("turn_start", {}, billed);
      expect(hits).toEqual([]);
    }
  });
});

describe("near the end of the credits (reserve)", () => {
  const reserves = (pi: ReturnType<typeof fakePi>) =>
    pi.messages.filter((m) => m.customType === "abacusai-bot-credits-reserve");

  it("tells the model the balance and to keep going in small steps, never to refuse", async () => {
    await balance(150, 2000, 2000, true);
    const { pi, lows } = governed("attended");
    await pi.fire("agent_start", {});
    await pi.fire("turn_start", {}, billed);
    await pi.fire("turn_start", {}, billed);

    expect(reserves(pi)).toHaveLength(1);
    const content = String(reserves(pi)[0]!.content);
    expect(content).toContain("150 credits left");
    expect(content).toContain("Do what the user asks");
    expect(content).toContain("present_deliverable");
    expect(content).not.toMatch(
      /do not start new work|stops mid-step|wrap up/i
    );
    expect(lows).toEqual([150]);
  });

  it("shows a free plan no notice: the reserve is the model's alone", async () => {
    await balance(150);
    const { pi, lows } = governed("attended");
    await pi.fire("turn_start", {}, billed);
    expect(reserves(pi)).toHaveLength(1);
    expect(lows).toEqual([]);
  });

  it("speaks again only when the turns-left estimate changes bucket", async () => {
    await balance(1900);
    const { pi } = governed("attended");
    // Three turns of 100 credits: 300 is the reserve line.
    for (let i = 0; i < 3; i++) {
      await pi.fire("input", { text: `t${i}`, source: "interactive" });
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, billed);
      noteBilledCredits(100);
    }
    await pi.fire("input", { text: "t3", source: "interactive" });
    await balance(290);
    await pi.fire("turn_start", {}, billed);
    await balance(250);
    await pi.fire("turn_start", {}, billed);
    expect(reserves(pi)).toHaveLength(1);
    expect(String(reserves(pi)[0]!.content)).toContain("about 2 turns");
    await balance(150);
    await pi.fire("turn_start", {}, billed);
    expect(reserves(pi)).toHaveLength(2);
    expect(String(reserves(pi)[1]!.content)).toContain("about 1 turn");
  });

  it("measures against the plan's credits, never what was bought on top", async () => {
    await balance(20_000, 330_000, 30_000);
    const { pi } = governed("attended");
    await pi.fire("turn_start", {}, billed);
    expect(reserves(pi)).toHaveLength(0);
    await balance(2_900, 330_000, 30_000);
    await pi.fire("turn_start", {}, billed);
    expect(reserves(pi)).toHaveLength(1);
  });

  it("says nothing to a routine run, a run nobody is in, or a model off Abacus credits", async () => {
    await balance(10);
    const routine = governed("routine");
    await routine.pi.fire("turn_start", {}, billed);
    expect(reserves(routine.pi)).toHaveLength(0);
    vi.stubEnv("ABACUSAI_BOT_NOBODY_PRESENT", "1");
    try {
      const nobody = governed("attended");
      await nobody.pi.fire("turn_start", {}, billed);
      expect(reserves(nobody.pi)).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
    const free = governed("attended", "abacus-free");
    await free.pi.fire("turn_start", {}, billed);
    expect(reserves(free.pi)).toHaveLength(0);
  });

  it("skips memory upkeep altogether while in reserve", async () => {
    await balance(10);
    const { pi, governor } = governed("phone");
    await pi.fire("turn_start", {}, billed);
    expect(governor.beginMemory()).toBe(false);
  });

  it("words the fact without a refusal in any form", () => {
    expect(reservePrompt(200, 3)).not.toMatch(/refuse|decline|do not start/i);
  });
});

describe("refreshing the balance", () => {
  const MINUTE = 60_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime((stamp += MINUTE));
  });
  afterEach(() => {
    setCreditRefresher(null);
    vi.useRealTimers();
  });

  it("asks the host after each billed call when the balance is stale, and never off Abacus", async () => {
    await balance(2000, 3000);
    const refresh = vi.fn(async () => ({
      remaining: 400,
      granted: 2000,
      at: Date.now(),
    }));
    setCreditRefresher(refresh);
    const { pi } = governed("attended");
    vi.advanceTimersByTime(10 * MINUTE);
    await pi.fire("turn_end", {}, ctxOn({ provider: "openrouter", id: "x" }));
    expect(refresh).not.toHaveBeenCalled();
    await pi.fire("turn_end", {}, billed);
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    expect(hostCreditBalance()?.remaining).toBe(400);
  });
});

describe("the context ceiling, by who pays", () => {
  const holder = (reserveTokens = 16_384) => ({
    getCompactionSettings: () => ({
      enabled: true,
      reserveTokens,
      keepRecentTokens: 20_000,
    }),
  });

  it("summarizes a billed chat past 160k, however large the window", () => {
    const { governor } = governed("attended");
    const manager = holder();
    governor.governContext(manager, () => billedModel);
    expect(manager.getCompactionSettings().reserveTokens).toBe(840_000);
  });

  it("keeps a routine at 80k and a free or own-key chat at 80% of its window", () => {
    const routine = governed("routine");
    const r = holder();
    routine.governor.governContext(r, () => billedModel);
    expect(r.getCompactionSettings().reserveTokens).toBe(920_000);

    const own = governed("attended", "own-key");
    const o = holder();
    own.governor.governContext(o, () => ({
      provider: "gemini",
      id: "g",
      contextWindow: 1_000_000,
    }));
    expect(o.getCompactionSettings().reserveTokens).toBe(200_000);
  });

  it("keeps pi's reserve when it is larger, and leaves an unknown window alone", () => {
    const { governor } = governed("attended", "own-key");
    const small = holder();
    governor.governContext(small, () => ({
      provider: "x",
      id: "y",
      contextWindow: 32_000,
    }));
    expect(small.getCompactionSettings().reserveTokens).toBe(16_384);
    const unknown = holder();
    governor.governContext(unknown, () => undefined);
    expect(unknown.getCompactionSettings().reserveTokens).toBe(16_384);
  });

  /** One of the session's own requests: its context and what it billed. */
  const request = (
    pi: ReturnType<typeof fakePi>,
    tokens: number,
    credits: number
  ) =>
    pi.fire("message_end", {
      message: {
        role: "assistant",
        usage: { input: tokens, cacheRead: 0 },
        abacusCredits: credits,
      },
    });

  it("summarizes once a request bills over 2% of the plan, if the price follows the context", async () => {
    await balance(2000, 3000);
    const { pi, governor } = governed("attended");
    const manager = holder();
    governor.governContext(manager, () => billedModel);
    await pi.fire("input", { text: "go", source: "interactive" });
    await request(pi, 40_000, 20);
    expect(manager.getCompactionSettings().reserveTokens).toBe(840_000);
    await request(pi, 100_000, 70);
    // Threshold drops to half the last request's size, so pi compacts first.
    expect(manager.getCompactionSettings().reserveTokens).toBe(950_000);
    governor.noteCompacted();
    expect(manager.getCompactionSettings().reserveTokens).toBe(840_000);
    // Once per user turn: a second costly request waits for the next turn.
    await request(pi, 120_000, 80);
    expect(manager.getCompactionSettings().reserveTokens).toBe(840_000);
    await pi.fire("input", { text: "more", source: "interactive" });
    await request(pi, 120_000, 80);
    expect(manager.getCompactionSettings().reserveTokens).toBe(940_000);
  });

  it("never summarizes below the floor, nor on a flat price, nor for requests not the chat's own", async () => {
    await balance(2000, 3000);
    const floor = governed("attended");
    const f = holder();
    floor.governor.governContext(f, () => billedModel);
    await request(floor.pi, 20_000, 10);
    await request(floor.pi, 30_000, 70);
    // Half of 30k would be 15k: the floor (20k) holds.
    expect(f.getCompactionSettings().reserveTokens).toBe(980_000);

    // A flat price: the context grew, the price did not, so a summary saves nothing.
    const flat = governed("attended");
    const m = holder();
    flat.governor.governContext(m, () => billedModel);
    for (const tokens of [40_000, 80_000, 120_000])
      await request(flat.pi, tokens, 70);
    expect(m.getCompactionSettings().reserveTokens).toBe(840_000);

    // Sub-agents' and memory upkeep's credits reach the meter, never the trigger.
    const own = governed("phone");
    const o = holder();
    own.governor.governContext(o, () => billedModel);
    await request(own.pi, 40_000, 20);
    noteBilledCredits(500);
    expect(o.getCompactionSettings().reserveTokens).toBe(840_000);
    own.governor.beginMemory();
    await request(own.pi, 100_000, 70);
    own.governor.endMemory();
    expect(o.getCompactionSettings().reserveTokens).toBe(840_000);
  });

  it("says a summary was made once, as the next request starts", async () => {
    const pi = fakePi();
    let told = 0;
    const governor = new SpendGovernor({
      kind: "attended",
      laneOf: () => "abacus-billed",
      onCompacted: () => told++,
    });
    governor.extension(pi.api as never);
    governor.noteCompacted();
    expect(told).toBe(0);
    await pi.fire("turn_start", {}, billed);
    await pi.fire("turn_start", {}, billed);
    expect(told).toBe(1);
  });

  it("keeps a summary made to recover from a refusal to itself: housekeeping, not news", async () => {
    const pi = fakePi();
    let told = 0;
    const governor = new SpendGovernor({
      kind: "attended",
      laneOf: () => "own-key",
      onCompacted: () => told++,
    });
    governor.extension(pi.api as never);
    await governor.recover("400 maximum context length is 200000", {
      session: {
        model: { provider: "x", id: "y", contextWindow: 200_000 },
        messages: [],
        systemPrompt: "",
        agent: { state: { tools: [] } },
        compact: async () => governor.noteCompacted("manual"),
        sendCustomMessage: async () => {},
      },
      continuation: { customType: "c", content: "go on" },
      interrupted: () => false,
      finishTurn: () => {},
      beyondCompaction: () => {},
    });
    governor.noteCompacted("overflow");
    await pi.fire("turn_start", {}, billed);
    expect(told).toBe(0);
  });
});

describe("the fit ladder after a refusal for size", () => {
  const groq = { provider: "groq", id: "llama", contextWindow: 131_072 };

  it("compacts once when one turn fits, then moves", () => {
    const { governor } = governed("attended", "own-key");
    expect(
      governor.fitStep(
        "400 maximum context length is 200000",
        groq,
        5_000,
        300_000
      )
    ).toEqual({ kind: "compact" });
    expect(
      governor.fitStep(
        "400 maximum context length is 200000",
        groq,
        5_000,
        300_000
      )
    ).toMatchObject({ kind: "move", oneTurnFits: true });
  });

  it("moves at once when one turn alone is over the stated limit, and no new chat is offered", () => {
    const { governor } = governed("attended", "own-key");
    const step = governor.fitStep(
      "413 Request too large for model llama on tokens per minute (TPM): Limit 6000, Requested 30000",
      groq,
      30_000,
      30_000
    );
    expect(step).toEqual({ kind: "move", need: 30_000, oneTurnFits: false });
    expect(governor.learnedLimit(groq)).toBe(6000);
    const card = governor.fitCard(
      [
        { id: "groq/llama", label: "Llama", contextWindow: 131_072 },
        { id: "gemini/pro", label: "Gemini Pro", contextWindow: 1_000_000 },
        { id: "x/tiny", label: "Tiny", contextWindow: 16_000 },
      ],
      groq,
      []
    );
    expect(card).toEqual({
      oneTurnFits: false,
      model: { model: "gemini/pro", label: "Gemini Pro" },
    });
  });
});

describe("memory upkeep and work nobody asked for", () => {
  it("leaves the user's turn meter running, and keeps upkeep out of the typical turn", async () => {
    await balance(2000, 3000);
    const { pi, governor } = governed("phone");
    await pi.fire("input", { text: "plan my week", source: "interactive" });
    noteBilledCredits(40);
    expect(governor.beginMemory()).toBe(true);
    noteBilledCredits(8);
    governor.endMemory();
    // The user's turn holds both: memory requests count into the turn.
    expect(governor.creditsThisTurn()).toBe(48);
  });

  it("closes them out without a line: upkeep and a verify follow-up stay unseen", async () => {
    await balance(2000, 3000);
    const memory = governed("phone");
    await memory.pi.fire("agent_start", {});
    memory.governor.beginMemory();
    noteBilledCredits(12);
    await memory.pi.fire("turn_start", {}, billed);
    expect(
      memory.pi.messages.some((m) => m.customType === "abacusai-bot-close-out")
    ).toBe(true);
    expect(memory.hits).toEqual([]);

    const verify = governed("attended", "own-key");
    await verify.pi.fire("agent_start", {});
    verify.governor.beginUnasked(2);
    await verify.pi.fire("turn_start", {}, ctxOn(undefined));
    await verify.pi.fire("turn_start", {}, ctxOn(undefined));
    expect(verify.governor.closing()).toBe(true);
    expect(verify.hits).toEqual([]);
  });
});

describe("Stop during the summary before a run", () => {
  it("reports the summary stopped, so the loop sends nothing", async () => {
    const { governor } = governed("attended");
    const session = {
      model: { provider: "abacus", id: "m", contextWindow: 200_000 },
      messages: [{ role: "user", content: "x".repeat(800_000) }],
      compact: async () => {
        throw new Error("Compaction cancelled");
      },
    };
    expect(await governor.preflight(session, "next")).toBe("stopped");
    session.compact = async () => {
      throw new Error("Nothing to compact (session too small)");
    };
    expect(await governor.preflight(session, "next")).toBeUndefined();
  });
});

describe("the model a too-big summary runs on", () => {
  const model = (
    id: string,
    provider: string,
    contextWindow: number,
    inputCost: number,
    free = false
  ) => ({ id, provider, contextWindow, inputCost, free });
  const choices = [
    model("abacus/premium", "abacus", 2_000_000, 15),
    model("abacus/router", "abacus", 1_000_000, 1),
    model("abacus/open", "abacus", 1_000_000, 0, true),
    model("groq/big", "groq", 500_000, 0.5),
    model("openrouter/free", "openrouter", 400_000, 0, true),
  ];
  const pick = (
    lane: Parameters<typeof summaryModelFor>[1]["lane"],
    provider?: string,
    credits = true
  ) =>
    summaryModelFor(choices, {
      tokens: 300_000,
      lane,
      current: provider == null ? undefined : { provider, id: "x" },
      freeProviders: ["openrouter", "groq"],
      credits,
    })?.id;

  it("never picks the priciest model by window; free first, then the cheapest that fits", () => {
    expect(pick("abacus-billed")).toBe("abacus/open");
    expect(pick("abacus-free")).toBe("abacus/open");
  });

  it("keeps an own-key chat on the user's own provider, and a free-lane chat on free models", () => {
    expect(pick("own-key", "groq")).toBe("groq/big");
    expect(pick("own-key", "mistral")).toBeUndefined();
    expect(pick("pool")).toBe("openrouter/free");
  });
});
