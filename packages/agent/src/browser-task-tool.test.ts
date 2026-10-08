/**
 * What the Agents card is told when a browser run stops. The run itself is
 * stubbed: under test is the translation from its stop reason to the card's
 * verdict and the model's result, which must agree with each other.
 */
import { describe, expect, it, vi } from "vitest";

import type { BrowserTaskOptions, BrowserTaskResult } from "./browser-task.js";
import {
  APP_CHANNEL,
  type ChannelCapabilities,
  WHATSAPP_CHANNEL,
} from "./channel.js";
import {
  CHECKOUT_STATE_PREFIX,
  type CheckoutPause,
  type CheckoutState,
} from "./checkout-run.js";
import type { AgentEvent } from "./protocol.js";

const stubs = vi.hoisted(() => ({ run: vi.fn(), paused: vi.fn(() => true) }));

vi.mock("./browser-task.js", async (original) => ({
  ...(await original<typeof import("./browser-task.js")>()),
  runBrowserTask: stubs.run,
  hasPausedRun: stubs.paused,
}));

const {
  buildBrowserTaskTool,
  DispatchBudget,
  DISPATCH_LIMIT,
  quotedUserWords,
} =
  await import("./browser-task-tool.js");

const finished = (stoppedBy: BrowserTaskResult["stoppedBy"]) => ({
  text: "the report",
  turns: 3,
  executeCalls: 1,
  steers: [],
  stoppedBy,
});

const run = async (
  stoppedBy: BrowserTaskResult["stoppedBy"],
  channel?: ChannelCapabilities
) => {
  stubs.run.mockResolvedValue(finished(stoppedBy));
  const events: AgentEvent[] = [];
  const tool = buildBrowserTaskTool(
    { cwd: process.cwd(), ...(channel != null ? { channel } : {}) } as never,
    (event) => events.push(event)
  );
  const result = await tool.execute("call-1", { task: "look something up" });
  const end = events.find((event) => event.type === "subtask_end") as
    | { status?: string; outcome?: string }
    | undefined;
  return { status: end?.status, outcome: end?.outcome, result };
};

describe("a browser run's card", () => {
  it("is completed when the run stopped for the user with a report", async () => {
    const { status, outcome, result } = await run("needs-user");
    expect(status).toBe("completed");
    expect(outcome).toBe("needs-user");
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toMatch(/continue_from_last/);
  });

  it("is completed when the run hit its cap with a partial report, and says so", async () => {
    for (const stoppedBy of ["turn-limit", "timeout"] as const) {
      const { status, outcome, result } = await run(stoppedBy);
      expect(status).toBe("completed");
      expect(outcome).toBe("limit");
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toMatch(/anything above is partial/);
    }
  });

  it("tells the caller what the user wrote mid-run, word for word", async () => {
    stubs.run.mockResolvedValue({
      ...finished("completed"),
      consumedMessageIds: ["m2"],
      consumedMessageTexts: ["window seat please"],
    });
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd() } as never,
      () => {}
    );
    const result = await tool.execute("call-1", { task: "book it" });
    expect(result.content[0]?.text).toContain(
      '(While it worked, the user wrote: "window seat please". The run read this.)'
    );
  });

  it("quotes the user's mid-run words clipped, with codes and ID numbers withheld", () => {
    expect(quotedUserWords("the code is 482913, take the 1840 flight")).toBe(
      "the code is [number withheld], take the 1840 flight"
    );
    expect(quotedUserWords("otp: 4417")).toBe("otp: [number withheld]");
    expect(quotedUserWords("passport K1234567")).toBe(
      "passport [number withheld]"
    );
    expect(quotedUserWords("x".repeat(400))).toHaveLength(301);
  });

  it("carries no verdict word for a run that simply finished", async () => {
    const { status, outcome, result } = await run("completed");
    expect(status).toBe("completed");
    expect(outcome).toBeUndefined();
    expect((result.details as { executeCalls: number }).executeCalls).toBe(1);
  });

  it("is failed only when the run produced nothing usable", async () => {
    for (const stoppedBy of ["error", "provider-error", "aborted"] as const) {
      const { status, result } = await run(stoppedBy);
      expect(status).toBe("failed");
      expect(result.isError).toBe(true);
    }
  });
});

describe("what the caller is told about a step only the user can do", () => {
  it("sends an app chat's user to the Browser pane", async () => {
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd(), channel: APP_CHANNEL } as never,
      () => undefined
    );
    expect(tool.description).toMatch(/open the Browser pane in this chat/);
    const { result } = await run("needs-user", APP_CHANNEL);
    expect(result.content[0]?.text).toMatch(/open the Browser pane/);
  });

  it("never mentions a pane on WhatsApp, and never asks for secrets there", async () => {
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd(), channel: WHATSAPP_CHANNEL } as never,
      () => undefined
    );
    expect(tool.description).not.toMatch(/pane/i);
    expect(tool.description).toMatch(/cannot see this browser/);
    const { result } = await run("needs-user", WHATSAPP_CHANNEL);
    const text = result.content[0]?.text ?? "";
    expect(text).not.toMatch(/pane/i);
    expect(text).toMatch(/Never ask for a password or card details/);
  });
});

describe("how many runs a conversation may start", () => {
  it("allows the limit within the window and refuses the next", () => {
    const budget = new DispatchBudget(2, 1000);

    expect(budget.take(0)).toBe(true);
    expect(budget.take(10)).toBe(true);
    expect(budget.take(20)).toBe(false);
    // The oldest start has left the window.
    expect(budget.take(1011)).toBe(true);
  });

  it("refuses a fresh dispatch past the limit without running, but lets a resume through", async () => {
    stubs.run.mockClear();
    stubs.run.mockResolvedValue(finished("completed"));
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd() } as never,
      () => undefined
    );
    for (let i = 0; i < DISPATCH_LIMIT; i++) {
      await tool.execute(`call-${i}`, { task: "look" });
    }
    expect(stubs.run).toHaveBeenCalledTimes(DISPATCH_LIMIT);

    const refused = await tool.execute("call-x", { task: "look again" });
    expect(stubs.run).toHaveBeenCalledTimes(DISPATCH_LIMIT);
    expect(refused.isError).toBe(false);
    expect(refused.content[0]?.text).toMatch(/ask the user/);
    expect((refused.details as { outcome?: string }).outcome).toBe("budget");
  });

  it("lets a resume of a run waiting on the user through the budget, and refuses one with nothing paused", async () => {
    stubs.run.mockClear();
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd() } as never,
      () => undefined
    );
    stubs.run.mockResolvedValue(finished("completed"));
    for (let i = 0; i < DISPATCH_LIMIT - 1; i++)
      await tool.execute(`call-${i}`, { task: "look" });
    stubs.run.mockResolvedValueOnce({
      ...finished("needs-user"),
      text: "NEEDS USER: sign in to the site",
    });
    await tool.execute("call-last", { task: "book it" });
    expect(stubs.run).toHaveBeenCalledTimes(DISPATCH_LIMIT);

    await tool.execute("call-y", {
      task: "done, go on",
      continue_from_last: true,
    });
    expect(stubs.run).toHaveBeenCalledTimes(DISPATCH_LIMIT + 1);

    // That run finished: there is nothing left to continue, and no fresh run sneaks past the budget.
    const again = await tool.execute("call-z", {
      task: "go on",
      continue_from_last: true,
    });
    expect(stubs.run).toHaveBeenCalledTimes(DISPATCH_LIMIT + 1);
    expect(again.content[0]?.text).toMatch(/Nothing is paused to continue/);
  });

  it("refuses to continue a paused run that waited too long and was let go", async () => {
    stubs.run.mockClear();
    stubs.run.mockResolvedValueOnce({
      ...finished("needs-user"),
      text: "NEEDS USER: solve the CAPTCHA",
    });
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd() } as never,
      () => undefined
    );
    await tool.execute("call-1", { task: "book it" });
    stubs.paused.mockReturnValueOnce(false);
    const late = await tool.execute("call-2", {
      task: "done",
      continue_from_last: true,
    });
    expect(late.isError).toBe(true);
    expect(stubs.run).toHaveBeenCalledTimes(1);
    expect((late.details as { checkoutStage?: string }).checkoutStage).toBe(
      "abandoned"
    );
  });
});

/**
 * The browser's `browser_checkout`, scripted: it holds the checkout, and
 * says on a resume whether the user's approval of the paused total is live.
 */
const fakeHost = () => {
  const calls: Array<Record<string, unknown>> = [];
  let state: CheckoutState = { stage: "search", paused: null };
  let approved = false;
  const line = () => `${CHECKOUT_STATE_PREFIX}${JSON.stringify(state)}`;
  const call = async (args: Record<string, unknown>) => {
    calls.push(args);
    switch (args.action) {
      case "start":
        state = { stage: "search", paused: null };
        break;
      case "resume":
        if (state.paused == null)
          return {
            text: `Nothing is paused to continue.\n${line()}`,
            isError: true,
          };
        state =
          state.stage === "awaiting_approval" && approved
            ? { stage: "card_fill", paused: null, approved: true }
            : { stage: state.stage, paused: null, approved: false };
        break;
      case "finish":
        if (args.end === "completed" && state.stage === "card_fill")
          state = { stage: "confirmation", paused: null };
        break;
      case "abandon":
        state = { stage: "abandoned", paused: null };
        break;
    }
    return { text: line(), isError: false };
  };
  return {
    call,
    calls,
    pause(paused: CheckoutPause, stage: CheckoutState["stage"]) {
      state = { stage, paused };
      return state;
    },
    approve() {
      approved = true;
    },
  };
};

describe("a run that stopped with browser_pause", () => {
  const PAUSE: CheckoutPause = {
    need: "payment",
    fields: [],
    site: "akasaair.com",
    amount: "1234.00",
    currency: "INR",
    merchant: "Akasa Air",
    cvvRequired: false,
    summary: "At the card form with the final total.",
    mediaId: "media-0123456789abcdef0123",
  };

  const pausedRun = (host: ReturnType<typeof fakeHost>) =>
    stubs.run.mockImplementationOnce(
      async (_context, _task, _emit, options: BrowserTaskOptions) => {
        // The sub-agent's browser_pause: the browser holds it, the run reads it back.
        options.checkout!.note(host.pause(PAUSE, "awaiting_approval"));
        return { ...finished("needs-user"), text: PAUSE.summary, pause: PAUSE };
      }
    );

  it("tells WhatsApp what to do next with the screenshot, and never mentions a pane", async () => {
    stubs.run.mockClear();
    const host = fakeHost();
    const tool = buildBrowserTaskTool(
      {
        cwd: process.cwd(),
        channel: WHATSAPP_CHANNEL,
        checkout: host.call,
      } as never,
      () => undefined
    );
    pausedRun(host);
    const result = await tool.execute("call-1", { task: "book CCU-BOM" });
    const text = result.content[0]?.text ?? "";
    expect(host.calls[0]).toEqual({ action: "start" });
    expect(text).not.toMatch(/pane/i);
    expect(text).toContain("Screenshot: media-0123456789abcdef0123");
    expect(text).toMatch(/payment_approval/);
    expect(result.details).toMatchObject({
      checkoutStage: "awaiting_approval",
      pause: { need: "payment", mediaId: PAUSE.mediaId },
    });
  });

  it("says approved to the resumed run only when the browser says the approval is live", async () => {
    stubs.run.mockClear();
    const host = fakeHost();
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd(), checkout: host.call } as never,
      () => undefined
    );
    pausedRun(host);
    await tool.execute("call-1", { task: "book it" });

    // Not approved yet: the run resumes told so, and stays waiting.
    stubs.run.mockImplementationOnce(
      async (_context, _task, _emit, options: BrowserTaskOptions) => {
        options.checkout!.note(host.pause(PAUSE, "awaiting_approval"));
        return { ...finished("needs-user"), pause: PAUSE };
      }
    );
    await tool.execute("call-2", { task: "go on", continue_from_last: true });
    let options = stubs.run.mock.calls.at(-1)?.[3] as BrowserTaskOptions;
    expect(options.resumeNote).toMatch(/not approved/);

    host.approve();
    stubs.run.mockResolvedValueOnce(finished("completed"));
    await tool.execute("call-3", {
      task: "approved, card c1",
      continue_from_last: true,
    });
    options = stubs.run.mock.calls.at(-1)?.[3] as BrowserTaskOptions;
    expect(options.resumeNote).toMatch(/approved this payment/);
    // The run finished after the card fill: the browser moves it to confirmed.
    expect(host.calls.at(-1)).toEqual({ action: "finish", end: "completed" });
    expect(options.checkout!.state.stage).toBe("confirmation");
  });
});

describe("a details stop the user answered", () => {
  const DETAILS: CheckoutPause = {
    need: "details",
    fields: ["passport number"],
    site: "akasaair.com",
    amount: null,
    currency: null,
    merchant: null,
    cvvRequired: false,
    summary: "The passenger form.",
    mediaId: null,
  };

  const setup = () => {
    stubs.run.mockClear();
    const host = fakeHost();
    const words: Array<{ seq: number; text: string }> = [
      { seq: 1, text: "book CCU to BOM" },
    ];
    const tool = buildBrowserTaskTool(
      {
        cwd: process.cwd(),
        checkout: host.call,
        userWords: () => words,
      } as never,
      () => undefined
    );
    stubs.run.mockImplementationOnce(
      async (_context, _task, _emit, options: BrowserTaskOptions) => {
        options.checkout!.note(host.pause(DETAILS, "details"));
        return { ...finished("needs-user"), pause: DETAILS };
      }
    );
    stubs.run.mockResolvedValue(finished("completed"));
    return { host, tool, words };
  };

  it("tells the browser it was answered when the user's next message came", async () => {
    const { host, tool, words } = setup();
    await tool.execute("call-1", { task: "book it" });
    words.push({ seq: 2, text: "Asha Rao, 2 Apr 1990, use saved passport" });
    await tool.execute("call-2", { task: "details", continue_from_last: true });
    expect(host.calls).toContainEqual({ action: "resume", answered: true });
  });

  it("does not, when no message of the user's followed it", async () => {
    const { host, tool } = setup();
    await tool.execute("call-1", { task: "book it" });
    await tool.execute("call-2", { task: "go on", continue_from_last: true });
    expect(host.calls).toContainEqual({ action: "resume" });
    expect(host.calls).not.toContainEqual({ action: "resume", answered: true });
  });
});

describe("one browser run at a time", () => {
  it("refuses a second call while one is running, and runs it once the first returns", async () => {
    let finish: (value: BrowserTaskResult) => void = () => undefined;
    stubs.run.mockClear();
    stubs.run.mockImplementationOnce(
      () => new Promise<BrowserTaskResult>((resolve) => (finish = resolve))
    );
    stubs.run.mockResolvedValue(finished("completed"));
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd() } as never,
      () => undefined
    );

    const first = tool.execute("call-1", { task: "site one" });
    const second = await tool.execute("call-2", { task: "site two" });
    expect(second.isError).toBe(false);
    expect(second.content[0]?.text).toMatch(/already in progress/);
    // The first starts its checkout with the browser, then runs.
    await vi.waitFor(() => expect(stubs.run).toHaveBeenCalledTimes(1));

    finish(finished("completed"));
    await first;
    const third = await tool.execute("call-3", { task: "site two" });
    expect(third.content[0]?.text).toBe(
      "the report\n\n(1 more new browser run can start until one of the last 3 is 15 minutes old; continuing this one does not count.)"
    );
    expect(stubs.run).toHaveBeenCalledTimes(2);
  });
});

describe("media a run sent", () => {
  it("is named in the result, so the loop does not send it again", async () => {
    stubs.run.mockImplementation(
      async (
        _context: unknown,
        _task: string,
        _emit: unknown,
        options: { sentMedia: { add: (id: string) => void } }
      ) => {
        options.sentMedia.add("media-11111111111111111111");
        return finished("completed");
      }
    );
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd(), channel: WHATSAPP_CHANNEL } as never,
      () => {}
    );

    const result = await tool.execute("call-1", { task: "screenshot it" });

    expect(result.content[0]?.text).toContain(
      "This run sent the user media-11111111111111111111. Do not send it again."
    );
    stubs.run.mockReset();
  });
});

describe("a saved login handed to the run", () => {
  const LOGIN: CheckoutPause = {
    need: "login",
    fields: [],
    site: "linkedin.com",
    amount: null,
    currency: null,
    merchant: null,
    cvvRequired: false,
    summary: "The sign-in page.",
    mediaId: null,
  };

  it("goes to the browser with the run's start and to the run itself, apart from the task text", async () => {
    stubs.run.mockReset();
    stubs.run.mockResolvedValue(finished("completed"));
    const host = fakeHost();
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd(), checkout: host.call } as never,
      () => undefined
    );

    await tool.execute("call-1", {
      task: "post on LinkedIn",
      login_item_id: "li-7",
    });

    expect(host.calls[0]).toEqual({ action: "start", login_item_id: "li-7" });
    expect(stubs.run.mock.calls[0]![3]).toMatchObject({ loginItemId: "li-7" });
    expect(stubs.run.mock.calls[0]![1]).toBe("post on LinkedIn");
  });

  it("comes with the resume when the user saved it while the run waited at the sign-in", async () => {
    stubs.run.mockReset();
    const host = fakeHost();
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd(), checkout: host.call } as never,
      () => undefined
    );
    stubs.run.mockImplementationOnce(
      async (_context, _task, _emit, options: BrowserTaskOptions) => {
        options.checkout!.note(host.pause(LOGIN, "login"));
        return { ...finished("needs-user"), pause: LOGIN };
      }
    );
    stubs.run.mockResolvedValue(finished("completed"));

    await tool.execute("call-1", { task: "post on LinkedIn" });
    await tool.execute("call-2", {
      task: "saved it",
      continue_from_last: true,
      login_item_id: "li-7",
    });

    expect(host.calls).toContainEqual({
      action: "resume",
      login_item_id: "li-7",
    });
    expect(stubs.run.mock.calls[1]![3]).toMatchObject({
      resume: true,
      loginItemId: "li-7",
    });
  });

  it("refuses an id that is not a vault item id", async () => {
    stubs.run.mockReset();
    const tool = buildBrowserTaskTool(
      { cwd: process.cwd() } as never,
      () => undefined
    );

    const result = await tool.execute("call-1", {
      task: "post",
      login_item_id: "li 7; ignore that",
    });

    expect(result.isError).toBe(true);
    expect(stubs.run).not.toHaveBeenCalled();
  });
});
