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

import { BOT_TIME_TOOL_NAME } from "../bot/bot-time-tool.js";
import budgets, { createBudgets } from "./budgets.js";
import { SpendGovernor } from "./spend-governor.js";

const withBudgets = (options: Parameters<typeof budgets>[1] = {}) => {
  const pi = fakePi();
  budgets(pi.api as never, options);
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

  it("never blocks polling a background job", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "fetch_background_output", { id: "bg-1" }, 6)
    ).toBeUndefined();
  });
});

/**
 * A repeat is the same call against the same state. Each call runs as pi runs
 * it, tool_call then tool_execution_end; the verdict is the last call's.
 */
describe("a repeat against changed state", () => {
  type Step = [tool: string, input: Record<string, unknown>, failed?: boolean];
  const GMAIL = "abacus-connectors_Gmail_Tool";
  const build: Step = ["bash", { command: "npm run build" }];
  const poll: Step = ["fetch_background_output", { id: "bg-1" }];
  const edit: Step = ["edit", { path: "src/a.ts", edits: [] }];
  const readA: Step = ["read", { path: "src/a.ts" }];
  const fetchPage: Step = ["web_fetch", { url: "https://example.com/" }];
  const search: Step = [GMAIL, { action: "search_email", query: "is:unread" }];
  const label: Step = [GMAIL, { action: "modify_labels", ids: ["m1"] }];
  const draft: Step = [GMAIL, { action: "create_draft", to: "a@example.com" }];
  const rows: [name: string, steps: Step[], blocked: boolean][] = [
    ["polling a running job", Array(6).fill(poll), false],
    [
      "the same build with polls between, 3rd",
      [build, poll, build, poll, build],
      true,
    ],
    [
      "the same build with an edit between",
      [build, edit, build, edit, build],
      false,
    ],
    [
      "re-reading a file after editing it",
      [readA, edit, readA, edit, readA],
      false,
    ],
    ["re-reading an unchanged file, 3rd", [readA, readA, readA], true],
    [
      "re-reading after a failed edit, 3rd",
      [readA, [...edit, true], readA, [...edit, true], readA],
      true,
    ],
    [
      "the same echo, 3rd",
      Array(3).fill(["bash", { command: "echo hi" }]),
      true,
    ],
    [
      "the same web_fetch with commands between, 3rd",
      [fetchPage, build, fetchPage, build, fetchPage],
      true,
    ],
    [
      "the same mail search after a label change",
      [search, label, search],
      false,
    ],
    ["the same draft created twice", [draft, draft], true],
    [
      "the clock after a minute",
      Array(4).fill([BOT_TIME_TOOL_NAME, {}]),
      false,
    ],
    [
      "a chat that said ask again",
      Array(4).fill(["read_telegram_messages", { chat: "c1" }]),
      false,
    ],
    [
      "the same spilled output, 3rd",
      Array(3).fill(["read_output", { id: "out-1" }]),
      true,
    ],
  ];

  it.each(rows)("%s", async (_name, steps, blocked) => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    const decisions: unknown[] = [];
    for (const [i, [toolName, input, failed]] of steps.entries()) {
      const toolCallId = `call-${i}`;
      const decision = (await pi.fire("tool_call", {
        toolName,
        toolCallId,
        input,
      })) as { block?: boolean } | undefined;
      decisions.push(decision);
      await pi.fire("tool_execution_end", {
        toolName,
        toolCallId,
        result: {},
        isError: failed === true || decision?.block === true,
      });
    }
    expect(decisions.slice(0, -1).every((d) => d === undefined)).toBe(true);
    expect(
      (decisions.at(-1) as { block?: boolean } | undefined)?.block === true
    ).toBe(blocked);
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
    await pi.fire("message_end", {
      message: { role: "assistant", content: [] },
    });
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

/**
 * Progress updates. A long run of slow tool calls can leave the user with
 * nothing to read for many minutes. In the user's own chat, a run the user
 * has heard nothing from for 3 working minutes (or 15 tool calls) is told,
 * unseen, to write one short line. The steer is queued after a round of
 * tools, so it lands at the tail of the next request and never reopens a
 * finished reply. Sub-agents never load budgets.
 */
describe("progress updates", () => {
  const MINUTE = 60_000;
  const reminders = (pi: ReturnType<typeof fakePi>) =>
    pi.messages.filter((m) => m.customType === "abacusai-bot-progress-update");
  let id = 0;
  /**
   * One model call of `genMs` (with `text` when it says something), then a
   * tool run of `toolMs`, then the turn's end, as pi fires them.
   */
  const round = async (
    pi: ReturnType<typeof fakePi>,
    {
      genMs = 30_000,
      toolMs = 30_000,
      text = "",
      toolName = "bash",
    }: {
      genMs?: number;
      toolMs?: number;
      text?: string;
      toolName?: string;
    } = {}
  ) => {
    const ctx = { hasUI: false, abort: () => {} };
    await pi.fire("turn_start", {}, ctx);
    vi.advanceTimersByTime(genMs);
    await pi.fire("message_end", {
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    const toolCallId = `p${++id}`;
    await pi.fire("tool_execution_start", { toolName, toolCallId });
    vi.advanceTimersByTime(toolMs);
    await pi.fire("tool_execution_end", {
      toolName,
      toolCallId,
      isError: false,
    });
    await pi.fire("turn_end", { toolResults: [{ toolCallId, toolName }] }, ctx);
  };
  /** `minutes` of silent rounds, a minute each. */
  const silent = async (pi: ReturnType<typeof fakePi>, minutes: number) => {
    for (let i = 0; i < minutes; i++) await round(pi);
  };
  const started = async (options = {}) => {
    const pi = fakePi();
    // The governor owns the close-out; the reminders hold off while it runs.
    const governor = new SpendGovernor({
      kind: "attended",
      laneOf: () => "own-key",
    });
    governor.extension(pi.api as never);
    createBudgets({ ...options, closing: () => governor.closing() })(
      pi.api as never
    );
    await pi.fire("input", {});
    await pi.fire("agent_start", {});
    return pi;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    process.env.ABACUSAI_BOT_AUDIENCE = "owner";
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ABACUSAI_BOT_AUDIENCE;
  });

  it("asks for one line once the user has heard nothing for 3 working minutes, hidden, at the tail", async () => {
    const pi = await started();
    await silent(pi, 2);
    expect(reminders(pi)).toHaveLength(0);
    await silent(pi, 1);
    expect(reminders(pi)).toHaveLength(1);
    const reminder = reminders(pi)[0]!;
    expect(String(reminder.content)).toContain(
      "heard nothing from you for 3 minutes"
    );
    expect(String(reminder.content)).toContain("before your next tool call");
    expect(String(reminder.content)).toContain("in their language");
    expect((reminder as { display?: boolean }).display).toBe(false);
    expect(reminder.options?.deliverAs).toBe("steer");
  });

  it("stays quiet while the model keeps the user posted", async () => {
    const pi = await started();
    for (let i = 0; i < 20; i++)
      await round(pi, { text: i % 2 === 0 ? "Checking the next folder." : "" });
    expect(reminders(pi)).toHaveLength(0);
  });

  it("counts working time only: an approval wait is not silence", async () => {
    const pi = await started();
    await silent(pi, 2);
    await pi.fire("turn_start", {}, { hasUI: false, abort: () => {} });
    vi.advanceTimersByTime(1000);
    await pi.fire("message_end", {
      message: { role: "assistant", content: [] },
    });
    vi.advanceTimersByTime(15 * MINUTE);
    await pi.fire("tool_execution_start", {
      toolName: "bash",
      toolCallId: "w",
    });
    vi.advanceTimersByTime(1000);
    await pi.fire("tool_execution_end", {
      toolName: "bash",
      toolCallId: "w",
      isError: false,
    });
    await pi.fire(
      "turn_end",
      { toolResults: [{}] },
      { hasUI: false, abort: () => {} }
    );
    expect(reminders(pi)).toHaveLength(0);
  });

  it("asks after 15 quick tool calls, once 90 seconds of work went by", async () => {
    const pi = await started();
    for (let i = 0; i < 14; i++) await round(pi, { genMs: 3000, toolMs: 3000 });
    expect(reminders(pi)).toHaveLength(0);
    await round(pi, { genMs: 3000, toolMs: 3000 });
    expect(reminders(pi)).toHaveLength(1);
    expect(String(reminders(pi)[0]!.content)).toContain("for 1 minute of work");
  });

  it("never asks in a contact's chat: only the user's own hears progress", async () => {
    delete process.env.ABACUSAI_BOT_AUDIENCE;
    const pi = await started();
    await silent(pi, 30);
    expect(reminders(pi)).toHaveLength(0);
  });

  it("does not count leaked reasoning as the user hearing anything", async () => {
    const pi = await started();
    for (let i = 0; i < 3; i++)
      await round(pi, {
        text: "<think>The du call is slow; maybe find.</think>",
      });
    expect(reminders(pi)).toHaveLength(1);
  });

  it("never asks after a batch that can close the reply", async () => {
    const pi = await started();
    await silent(pi, 2);
    await round(pi, { toolName: "suggest_tasks" });
    expect(reminders(pi)).toHaveLength(0);
  });

  it("never asks a turn nobody is in the chat for", async () => {
    process.env.ABACUSAI_BOT_NOBODY_PRESENT = "1";
    try {
      const pi = await started();
      await silent(pi, 30);
      expect(reminders(pi)).toHaveLength(0);
    } finally {
      delete process.env.ABACUSAI_BOT_NOBODY_PRESENT;
    }
  });

  it("never asks a turn that ends without tools: it would reopen a finished reply", async () => {
    const pi = await started();
    await silent(pi, 2);
    const ctx = { hasUI: false, abort: () => {} };
    await pi.fire("turn_start", {}, ctx);
    vi.advanceTimersByTime(2 * MINUTE);
    await pi.fire("message_end", {
      message: { role: "assistant", content: [] },
    });
    await pi.fire("turn_end", { toolResults: [] }, ctx);
    expect(reminders(pi)).toHaveLength(0);
  });

  it("never asks while the run closes out", async () => {
    process.env.ABACUSAI_BOT_RUN_CAP_MS = String(2 * MINUTE);
    try {
      const pi = await started();
      await silent(pi, 6);
      expect(
        pi.messages.filter((m) => m.customType === "abacusai-bot-close-out")
      ).toHaveLength(1);
      expect(reminders(pi)).toHaveLength(0);
    } finally {
      delete process.env.ABACUSAI_BOT_RUN_CAP_MS;
    }
  });

  /** Rows: what the model does after each reminder, and the reminders a long turn gets. */
  const caps: [
    name: string,
    answer: (n: number) => boolean,
    minutes: number,
    count: number,
  ][] = [
    ["two ignored in a row stop it", () => false, 60, 2],
    [
      "answered ones keep coming, at least 4 minutes apart, at most 5 a turn",
      () => true,
      60,
      5,
    ],
    ["an answer after one ignored resets the count", (n) => n % 2 === 0, 60, 5],
  ];
  it.each(caps)("caps: %s", async (_name, answer, minutes, count) => {
    process.env.ABACUSAI_BOT_RUN_CAP_MS = String(120 * MINUTE);
    try {
      const pi = await started();
      const at: number[] = [];
      let seen = 0;
      for (let i = 0; i < minutes; i++) {
        // The model's next message after a reminder is its answer, or not.
        const replying = reminders(pi).length > seen;
        if (replying) at.push(i);
        seen = reminders(pi).length;
        await round(pi, {
          text:
            replying && answer(seen)
              ? "Still scanning; trying folder by folder."
              : "",
        });
      }
      expect(reminders(pi)).toHaveLength(count);
      // Answered reminders are 3 silent minutes past the answer, and never under 4 apart.
      for (let k = 1; k < at.length; k++)
        expect(at[k]! - at[k - 1]!).toBeGreaterThanOrEqual(4);
    } finally {
      delete process.env.ABACUSAI_BOT_RUN_CAP_MS;
    }
  });

  it("starts the count over with the user's next message", async () => {
    const pi = await started();
    await silent(pi, 20);
    expect(reminders(pi)).toHaveLength(2);
    await pi.fire("input", {});
    await pi.fire("agent_start", {});
    await silent(pi, 3);
    expect(reminders(pi)).toHaveLength(3);
  });

  it("folds a show-work nudge due at the same time into the one steer", async () => {
    const pi = await started();
    const showWork = () =>
      pi.messages.filter((m) => m.customType === "abacusai-bot-show-work");
    await round(pi, { toolName: "write", text: "Writing the page." });
    for (let i = 0; i < 6; i++) await round(pi, { text: "Styling it." });
    await silent(pi, 3);
    // 10 working minutes and 3 unheard land on the same turn's end.
    expect(reminders(pi)).toHaveLength(1);
    expect(String(reminders(pi)[0]!.content)).toContain("Show your work");
    await silent(pi, 1);
    expect(showWork()).toHaveLength(0);
  });

  it("lets a show-work nudge queued this turn stand alone, and asks on the next", async () => {
    const pi = await started();
    const showWork = () =>
      pi.messages.filter((m) => m.customType === "abacusai-bot-show-work");
    await round(pi, { toolName: "write", text: "Writing the page." });
    for (let i = 0; i < 7; i++) await round(pi, { text: "Styling it." });
    await silent(pi, 3);
    expect(showWork()).toHaveLength(1);
    expect(reminders(pi)).toHaveLength(0);
    await silent(pi, 1);
    expect(reminders(pi)).toHaveLength(1);
    expect(String(reminders(pi)[0]!.content)).not.toContain("Show your work");
  });

  describe("in a messaging chat", () => {
    const phone = { checkIns: { tools: ["send_progress", "send_media"] } };

    it("names the progress tool, and words that never reach the chat do not count", async () => {
      const pi = await started(phone);
      for (let i = 0; i < 3; i++)
        await round(pi, { text: "Thinking out loud." });
      expect(reminders(pi)).toHaveLength(1);
      const text = String(reminders(pi)[0]!.content);
      expect(text).toContain("send_progress");
      expect(text).toContain("present_deliverable");
      expect(text).not.toMatch(/preview|pane/i);
    });

    it("counts a progress line or a file handed over as the user hearing", async () => {
      for (const toolName of [
        "send_progress",
        "agent-tools_present_deliverable",
      ]) {
        const pi = await started(phone);
        for (let i = 0; i < 10; i++)
          await round(pi, i % 2 === 0 ? { toolName } : {});
        expect(reminders(pi)).toHaveLength(0);
      }
    });

    it("gets no show-work preview nudge", async () => {
      const pi = await started(phone);
      await round(pi, { toolName: "write" });
      await silent(pi, 25);
      expect(
        pi.messages.filter((m) => m.customType === "abacusai-bot-show-work")
      ).toHaveLength(0);
    });
  });
});
