import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The repeat guard breaks loops. It must not break looking again.
 *
 * Its refusal tells the model "Repeating it returns the same result", which is
 * true of reading a file and false of photographing a screen. Blocked on a
 * third screenshot, one run concluded the tool was deduplicating its calls and
 * started relaunching the app to "force a state change" rather than simply
 * looking again after a tap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostCore } from "../agui/queue.js";
import { hostCreditBalance, setCreditRefresher } from "../credit-balance.js";
import budgets, { budgetStopReason, createBudgets } from "./budgets.js";

const withBudgets = () => {
  const pi = fakePi();
  budgets(pi.api as never);
  return pi;
};

const call = (toolName: string, input: Record<string, unknown>) => ({
  toolName,
  toolCallId: "call-1",
  input,
});

/** Fire the same call `times` over, returning the last decision. */
const repeat = async (
  pi: ReturnType<typeof fakePi>,
  toolName: string,
  input: Record<string, unknown>,
  times: number
) => {
  let last: unknown;
  for (let i = 0; i < times; i++)
    last = await pi.fire("tool_call", call(toolName, input));
  return last as { block?: boolean; reason?: string } | undefined;
};

describe("repeating a call that reads stable state", () => {
  it("is blocked once it is plainly a loop", async () => {
    const pi = withBudgets();
    const decision = await repeat(pi, "read", { path: "src/index.ts" }, 3);

    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("already made this exact");
  });

  it("is allowed while it could still be deliberate", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "read", { path: "src/index.ts" }, 2)
    ).toBeUndefined();
  });
});

describe("repeating a call that samples live state", () => {
  it("never blocks a screenshot: taking it again after a tap is the job", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "device_screenshot", { udid: "sim-1" }, 6)
    ).toBeUndefined();
  });

  it("never blocks re-reading a browser page", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "browser_snapshot", { action: "text" }, 6)
    ).toBeUndefined();
  });

  it("never blocks polling streamed output", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "read_output", { id: "proc-1" }, 6)
    ).toBeUndefined();
  });
});

/**
 * The turn cap. A run that reached it used to be aborted on its next model
 * call with nothing said: the abort surfaced as a provider error with a
 * retry notice, and it landed on runs that had just handed the work over. Now the model is told to wrap up and present at 100 short, told
 * again at 50 short, and at the cap (or after an hour) it closes out: told to
 * write its closing message, its tools refused, and stopped with a message
 * written for the user only if it still has not finished.
 */
describe("connector calls", () => {
  const steers = (pi: ReturnType<typeof fakePi>) =>
    pi.messages
      .filter((m) => m.customType === "calite-budget")
      .map((m) => String(m.content));

  it("reminds the model what they cost on every fifth call, without blocking any", async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    const decisions: unknown[] = [];
    for (let i = 0; i < 12; i++)
      decisions.push(
        await pi.fire(
          "tool_call",
          call("abacus-connectors_Gmail_Tool", {
            action: "search_email",
            q: `q${i}`,
          })
        )
      );

    expect(decisions.every((d) => d === undefined)).toBe(true);
    expect(steers(pi)).toHaveLength(2);
    expect(steers(pi)[0]).toContain("5 connector calls");
    expect(steers(pi)[0]).toContain("10 credits");
    expect(steers(pi)[0]).toMatch(/complete the task now/);
    expect(steers(pi)[1]).toContain("10 connector calls");
  });

  it("blocks the second identical connector call, pointing at the result already in context", async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    const same = call("abacus-connectors_Gmail_Tool", {
      action: "search_email",
      query: "from:anup",
    });
    expect(await pi.fire("tool_call", same)).toBeUndefined();
    const second = (await pi.fire("tool_call", same)) as {
      block?: boolean;
      reason?: string;
    };
    expect(second.block).toBe(true);
    expect(second.reason).toContain("already made this exact");
    expect(second.reason).toContain("10 credits");
    // A tool the registry does not take is not a connector call at all.
    const git = call("abacus-connectors_Git_Tool", { action: "get_repo" });
    await pi.fire("tool_call", git);
    expect(await pi.fire("tool_call", git)).toBeUndefined();
  });

  it("counts only connector tools, and starts over each run", async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    for (let i = 0; i < 4; i++)
      await pi.fire(
        "tool_call",
        call("abacus-connectors_Gmail_Tool", { q: i })
      );
    for (let i = 0; i < 5; i++)
      await pi.fire("tool_call", call("bash", { command: `echo ${i}` }));
    expect(steers(pi)).toHaveLength(0);

    await pi.fire("agent_start", {});
    for (let i = 0; i < 4; i++)
      await pi.fire(
        "tool_call",
        call("abacus-connectors_Slack_Tool", { q: i })
      );
    expect(steers(pi)).toHaveLength(0);
    await pi.fire("tool_call", call("abacus-connectors_Slack_Tool", { q: 99 }));
    expect(steers(pi)).toHaveLength(1);
  });
});

describe("a run that runs long", () => {
  afterEach(() => {
    delete process.env.ABACUSAI_BOT_TURN_CAP;
  });

  const run = async (cap: number, turns: number) => {
    process.env.ABACUSAI_BOT_TURN_CAP = String(cap);
    const pi = withBudgets();
    const aborts: number[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { notify() {} },
      abort() {
        aborts.push(turns);
      },
    };
    await pi.fire("agent_start", {});
    for (let i = 0; i < turns; i++) await pi.fire("turn_start", {}, ctx);
    const steers = pi.messages
      .filter((m) => m.customType === "calite-budget")
      .map((m) => String(m.content));
    return { pi, aborts, steers };
  };

  it("asks it to wrap up and present what it has, 100 calls short of the cap", async () => {
    const { steers, aborts } = await run(250, 150);

    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("150 of 250");
    expect(steers[0]).toContain("present_deliverable");
    expect(steers[0]).toMatch(/circles|repeat/);
    expect(aborts).toEqual([]);
  });

  it("warns again, harder, 50 short", async () => {
    const { steers, aborts } = await run(250, 200);

    expect(steers).toHaveLength(2);
    expect(steers[1]).toContain("Final warning");
    expect(steers[1]).toContain("present_deliverable");
    expect(aborts).toEqual([]);
    expect(budgetStopReason()).toBeNull();
  });

  it("says nothing between the warnings", async () => {
    const { steers } = await run(250, 249);

    expect(steers).toHaveLength(2);
  });

  it("closes out past the cap instead of cutting the run mid-step", async () => {
    const { pi, aborts } = await run(250, 251);

    // Told, unseen, to stop and write its closing message; no tool runs now.
    expect(aborts).toEqual([]);
    expect(
      pi.messages.filter((m) => m.customType === "abacusai-bot-close-out")
    ).toEqual([
      expect.objectContaining({
        display: false,
        content: expect.stringContaining("closing message"),
      }),
    ]);
    const blocked = await pi.fire("tool_call", {
      toolName: "bash",
      toolCallId: "c",
      input: { command: "ls" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect(budgetStopReason()).toBeNull();
  });

  it("stops a run that has not closed out a few calls later, with a message written for the user, not the provider", async () => {
    const { aborts } = await run(250, 254);

    expect(aborts).toHaveLength(1);
    const reason = budgetStopReason() ?? "";
    expect(reason).toContain("250 model calls");
    expect(reason).toContain("going in circles");
    expect(reason).toContain("send a message");
    expect(reason).not.toMatch(/provider/i);
  });

  it("keeps the warnings in order on a cap too small to space them", async () => {
    const { steers } = await run(40, 40);

    // 40 - 100 and 40 - 50 both floor to turn 1: one warning, the harder one.
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("Final warning");
  });

  it("closes out after an hour of running, however few calls it made", async () => {
    vi.useFakeTimers();
    try {
      const pi = withBudgets();
      const ctx = {
        cwd: process.cwd(),
        hasUI: false,
        ui: { notify() {} },
        abort() {},
      };
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      vi.advanceTimersByTime(59 * 60_000);
      await pi.fire("turn_start", {}, ctx);
      expect(
        pi.messages.filter((m) => m.customType === "abacusai-bot-close-out")
      ).toEqual([]);

      vi.advanceTimersByTime(60_000);
      await pi.fire("turn_start", {}, ctx);
      expect(
        pi.messages.filter((m) => m.customType === "abacusai-bot-close-out")
      ).toEqual([
        expect.objectContaining({
          content: expect.stringContaining("60 minutes"),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the hour and the close-out across a hidden continuation of the same turn", async () => {
    vi.useFakeTimers();
    try {
      const pi = withBudgets();
      const aborts: number[] = [];
      const ctx = {
        cwd: process.cwd(),
        hasUI: false,
        ui: { notify() {} },
        abort() {
          aborts.push(1);
        },
      };
      const closeOuts = () =>
        pi.messages.filter((m) => m.customType === "abacusai-bot-close-out");
      await pi.fire("input", { text: "build it", source: "interactive" });
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      vi.advanceTimersByTime(40 * 60_000);
      // A stall's re-ask: a run of its own, the same turn.
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      vi.advanceTimersByTime(20 * 60_000);
      await pi.fire("turn_start", {}, ctx);
      expect(closeOuts()).toHaveLength(1);

      // An empty closing message's ask: still closing, its tools still refused.
      await pi.fire("agent_start", {});
      expect(
        await pi.fire("tool_call", {
          toolName: "bash",
          toolCallId: "c",
          input: { command: "ls" },
        })
      ).toMatchObject({ block: true });
      // Its two calls to close out, then the stop on the third.
      await pi.fire("turn_start", {}, ctx);
      await pi.fire("turn_start", {}, ctx);
      expect(aborts).toEqual([]);
      await pi.fire("turn_start", {}, ctx);
      expect(aborts).toHaveLength(1);

      // The user's next message is a new turn: a new hour.
      await pi.fire("input", { text: "go on", source: "interactive" });
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      expect(closeOuts()).toHaveLength(1);
      expect(
        await pi.fire("tool_call", {
          toolName: "bash",
          toolCallId: "d",
          input: { command: "ls" },
        })
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a closing run hand over what it made, and nothing else", async () => {
    vi.useFakeTimers();
    try {
      const pi = withBudgets();
      const ctx = {
        cwd: process.cwd(),
        hasUI: false,
        ui: { notify() {} },
        abort() {},
      };
      await pi.fire("input", { text: "build it", source: "interactive" });
      await pi.fire("agent_start", {});
      await pi.fire("turn_start", {}, ctx);
      vi.advanceTimersByTime(60 * 60_000);
      await pi.fire("turn_start", {}, ctx);
      const closeOut = pi.messages.find(
        (m) => m.customType === "abacusai-bot-close-out"
      );
      expect(String(closeOut?.content)).toContain("present_deliverable");

      for (const toolName of [
        "present_deliverable",
        "agent-tools_present_deliverable",
        "send_media",
      ])
        expect(
          await pi.fire("tool_call", {
            toolName,
            toolCallId: toolName,
            input: { path: "site/index.html" },
          })
        ).toBeUndefined();
      expect(
        await pi.fire("tool_call", {
          toolName: "write",
          toolCallId: "w",
          input: { path: "site/more.html" },
        })
      ).toMatchObject({ block: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the stop when the next run starts", async () => {
    const { pi } = await run(250, 254);
    expect(budgetStopReason()).not.toBeNull();

    await pi.fire("agent_start", {});

    expect(budgetStopReason()).toBeNull();
  });
});

/**
 * Show your work. A run on a cheap model spent 26 minutes drawing product
 * images for a store it never built, so there was nothing to preview. A run
 * that has written files but presented nothing is now told, unseen by the
 * user, to present after 10 minutes of working time, and again after 20.
 * Waiting on an approval is not working time.
 */
describe("show your work", () => {
  const MINUTE = 60_000;
  const showWork = (pi: ReturnType<typeof fakePi>) =>
    pi.messages.filter((m) => m.customType === "abacusai-bot-show-work");

  /** One model step of `ms`, ending in a reply. */
  const step = async (pi: ReturnType<typeof fakePi>, ms: number) => {
    await pi.fire("turn_start", {}, { hasUI: false, abort: () => {} });
    vi.advanceTimersByTime(ms);
    await pi.fire("message_end", { message: { role: "assistant" } });
  };
  /** One tool run of `ms`. */
  let id = 0;
  const tool = async (
    pi: ReturnType<typeof fakePi>,
    toolName: string,
    ms: number,
    isError = false
  ) => {
    const toolCallId = `t${++id}`;
    await pi.fire("tool_execution_start", { toolName, toolCallId });
    vi.advanceTimersByTime(ms);
    await pi.fire("tool_execution_end", { toolName, toolCallId, isError });
  };
  /** Steps of a minute each, running bash, until `minutes` of work. */
  const work = async (pi: ReturnType<typeof fakePi>, minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      await step(pi, 30_000);
      await tool(pi, "bash", 30_000);
    }
  };
  const started = async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    return pi;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("tells a build that showed nothing to present at 10 minutes and again at 20, hidden from the user", async () => {
    const pi = await started();
    await step(pi, 1000);
    await tool(pi, "write", 1000);
    await work(pi, 9);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);

    await work(pi, 1);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(1);
    expect(String(showWork(pi)[0]!.content)).toContain("over 10 minutes");
    expect(String(showWork(pi)[0]!.content)).toContain("present_deliverable");
    expect(String(showWork(pi)[0]!.content)).toMatch(/placeholder images/);
    expect(pi.messages.at(-1)?.options?.deliverAs).toBe("steer");
    expect((pi.messages.at(-1) as { display?: boolean }).display).toBe(false);

    await work(pi, 5);
    expect(showWork(pi)).toHaveLength(1);
    await work(pi, 5);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(2);
    expect(String(showWork(pi)[1]!.content)).toBe(
      String(showWork(pi)[0]!.content).replace("10 minutes", "20 minutes")
    );

    await work(pi, 30);
    expect(showWork(pi)).toHaveLength(2);
  });

  it("does not count time waiting on an approval", async () => {
    const pi = await started();
    await step(pi, 1000);
    await tool(pi, "write", 1000);
    // The model asks for a tool; the call waits 15 minutes for the user.
    await step(pi, 1000);
    vi.advanceTimersByTime(15 * MINUTE);
    await tool(pi, "bash", 1000);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);
  });

  it("stays quiet once the work was presented, under any server prefix", async () => {
    for (const name of [
      "present_deliverable",
      "abacusai-bot_present_deliverable",
    ]) {
      const pi = await started();
      await tool(pi, "write", 1000);
      await tool(pi, name, 1000);
      await work(pi, 25);
      await step(pi, 1000);
      expect(showWork(pi)).toHaveLength(0);
    }
  });

  it("does not count a failed presentation or a failed write", async () => {
    const pi = await started();
    await tool(pi, "write", 1000, true);
    await work(pi, 12);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);

    await tool(pi, "edit", 1000);
    await tool(pi, "present_deliverable", 1000, true);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(1);
  });

  it("never nudges a run that wrote nothing: research, email, answers", async () => {
    const pi = await started();
    await work(pi, 25);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);
  });

  it("starts over with each run", async () => {
    const pi = await started();
    await tool(pi, "write", 1000);
    await work(pi, 8);
    await pi.fire("agent_start", {});
    await tool(pi, "write", 1000);
    await work(pi, 8);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);
    await work(pi, 2);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(1);
  });
});

describe("credits running out", () => {
  const core = new HostCore({} as never, () => {});
  // Each read is newer than the last, as the host's are.
  let stamp = Date.now();
  const balance = (remaining: number, granted = 2000) =>
    core.handle({
      type: "credit_balance",
      remaining,
      granted,
      at: ++stamp,
    });
  const on = (model: Record<string, unknown>) => ({
    hasUI: false,
    abort() {},
    model,
  });
  const billed = on({ provider: "abacus", id: "premium-model" });
  const nudges = (pi: ReturnType<typeof fakePi>) =>
    pi.messages.filter((m) => m.customType === "abacusai-bot-credits-low");
  const started = async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    return pi;
  };

  it("takes the snapshot from the host's command", async () => {
    await balance(150);
    expect(hostCreditBalance()).toMatchObject({
      remaining: 150,
      granted: 2000,
    });
  });

  it("tells a billed Abacus run to wrap up below a tenth, once per session, hidden", async () => {
    await balance(150);
    const pi = await started();
    for (let i = 0; i < 3; i++) await pi.fire("turn_start", {}, billed);
    await pi.fire("agent_start", {});
    await pi.fire("turn_start", {}, billed);

    expect(nudges(pi)).toHaveLength(1);
    const [nudge] = nudges(pi);
    expect(String(nudge!.content)).toContain("150 of 2000 credits");
    expect(String(nudge!.content)).toContain("present_deliverable");
    expect(String(nudge!.content)).toMatch(/their own language/);
    expect(String(nudge!.content)).toMatch(/Do not start new work/);
    expect((nudge as { display?: boolean }).display).toBe(false);
    expect(nudge!.options?.deliverAs).toBe("steer");
  });

  it("stays quiet above the threshold, and speaks once a lower balance arrives", async () => {
    await balance(250);
    const pi = await started();
    await pi.fire("turn_start", {}, billed);
    expect(nudges(pi)).toHaveLength(0);

    await balance(199);
    await pi.fire("turn_start", {}, billed);
    expect(nudges(pi)).toHaveLength(1);
  });

  it("never nudges a free Abacus model or the user's own key", async () => {
    await balance(10);
    const pi = await started();
    await pi.fire("turn_start", {}, on({ provider: "abacus", free: true }));
    await pi.fire("turn_start", {}, on({ provider: "anthropic", id: "x" }));
    await pi.fire("turn_start", {}, { hasUI: false, abort() {} });
    expect(nudges(pi)).toHaveLength(0);
  });

  describe("refreshing the balance", () => {
    const MINUTE = 60_000;
    const settle = async () => {
      for (let i = 0; i < 3; i++) await Promise.resolve();
    };
    const toolEnd = (pi: ReturnType<typeof fakePi>, ctx: unknown) =>
      pi.fire(
        "tool_execution_end",
        { toolName: "bash", toolCallId: "t", isError: false },
        ctx
      );

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime((stamp += MINUTE));
    });
    afterEach(() => {
      setCreditRefresher(null);
      vi.useRealTimers();
    });

    it("asks the host after three minutes, then every minute once under a quarter", async () => {
      await balance(1500);
      const refresh = vi.fn(async () => ({
        remaining: 400,
        granted: 2000,
        at: Date.now(),
      }));
      setCreditRefresher(refresh);
      const pi = await started();

      vi.advanceTimersByTime(2 * MINUTE);
      await toolEnd(pi, billed);
      expect(refresh).not.toHaveBeenCalled();

      vi.advanceTimersByTime(MINUTE + 1);
      await toolEnd(pi, billed);
      await settle();
      expect(refresh).toHaveBeenCalledOnce();
      expect(hostCreditBalance()?.remaining).toBe(400);

      vi.advanceTimersByTime(MINUTE);
      await pi.fire("turn_end", {}, billed);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("never asks for a run that does not spend Abacus credits", async () => {
      await balance(1500);
      const refresh = vi.fn(async () => null);
      setCreditRefresher(refresh);
      const pi = await started();

      vi.advanceTimersByTime(10 * MINUTE);
      await toolEnd(pi, on({ provider: "abacus", free: true }));
      await toolEnd(pi, on({ provider: "openrouter", id: "x" }));
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});

/**
 * The same marks on a chat whose user waits in a messaging app: the phone
 * loop's user cannot see a preview, and a long research or browser run
 * writes no file, so the desktop's "built something, showed nothing" rule
 * would never fire there. Each mark checks in whenever the user heard
 * nothing since the last one.
 */
describe("check-ins in a messaging chat", () => {
  const checkIns = (pi: ReturnType<typeof fakePi>) =>
    pi.messages.filter((m) => m.customType === "abacusai-bot-show-work");
  const started = async () => {
    const pi = fakePi();
    createBudgets({ checkIns: { tools: ["send_progress", "send_media"] } })(
      pi.api as never
    );
    await pi.fire("agent_start", {});
    return pi;
  };
  let id = 0;
  /** `minutes` of work, a minute a step: a model call and a bash run. */
  const work = async (
    pi: ReturnType<typeof fakePi>,
    minutes: number,
    toolName = "bash"
  ) => {
    for (let i = 0; i < minutes; i++) {
      await pi.fire("turn_start", {}, { hasUI: false, abort: () => {} });
      vi.advanceTimersByTime(30_000);
      await pi.fire("message_end", { message: { role: "assistant" } });
      const toolCallId = `c${++id}`;
      await pi.fire("tool_execution_start", { toolName, toolCallId });
      vi.advanceTimersByTime(30_000);
      await pi.fire("tool_execution_end", {
        toolName,
        toolCallId,
        isError: false,
      });
    }
    await pi.fire("turn_start", {}, { hasUI: false, abort: () => {} });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("checks in at 10 and 20 minutes of work, files or not, hidden from the user", async () => {
    const pi = await started();
    await work(pi, 9);
    expect(checkIns(pi)).toHaveLength(0);

    await work(pi, 1);
    expect(checkIns(pi)).toHaveLength(1);
    const first = String(checkIns(pi)[0]!.content);
    expect(first).toContain("over 10 minutes");
    expect(first).toContain("send_progress");
    expect(first).toContain("present_deliverable");
    expect(first).not.toMatch(/preview|pane/i);
    expect(pi.messages.at(-1)?.options?.deliverAs).toBe("steer");

    await work(pi, 10);
    expect(checkIns(pi)).toHaveLength(2);
    expect(String(checkIns(pi)[1]!.content)).toContain("over 20 minutes");
  });

  it("stays quiet at a mark when the user heard from the run since the last one", async () => {
    const pi = await started();
    await work(pi, 8);
    await work(pi, 1, "send_progress");
    await work(pi, 2);
    expect(checkIns(pi)).toHaveLength(0);

    // Nothing since the 10-minute mark: the 20-minute one checks in.
    await work(pi, 10);
    expect(checkIns(pi)).toHaveLength(1);
    expect(String(checkIns(pi)[0]!.content)).toContain("over 20 minutes");
  });

  it("counts a file handed over as hearing from the run", async () => {
    const pi = await started();
    await work(pi, 9, "agent-tools_present_deliverable");
    await work(pi, 2);
    expect(checkIns(pi)).toHaveLength(0);
  });

  it("leaves the desktop's rule alone: no file written, no nudge", async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    await work(pi, 25);
    expect(checkIns(pi)).toHaveLength(0);
  });
});
