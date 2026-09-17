/**
 * What the Agents card is told when a browser run stops. The run itself is
 * stubbed: under test is the translation from its stop reason to the card's
 * verdict and the model's result, which must agree with each other.
 */
import { describe, expect, it, vi } from "vitest";

import type { BrowserTaskResult } from "./browser-task.js";
import type { AgentEvent } from "./protocol.js";

const stubs = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("./browser-task.js", () => ({ runBrowserTask: stubs.run }));

const { buildBrowserTaskTool, DispatchBudget, DISPATCH_LIMIT } =
  await import("./browser-task-tool.js");

const finished = (stoppedBy: BrowserTaskResult["stoppedBy"]) => ({
  text: "the report",
  turns: 3,
  executeCalls: 1,
  steers: [],
  stoppedBy,
});

const run = async (stoppedBy: BrowserTaskResult["stoppedBy"]) => {
  stubs.run.mockResolvedValue(finished(stoppedBy));
  const events: AgentEvent[] = [];
  const tool = buildBrowserTaskTool({ cwd: process.cwd() } as never, (event) =>
    events.push(event)
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
      expect(result.content[0]?.text).toMatch(/may be incomplete/);
    }
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

    await tool.execute("call-y", {
      task: "done, go on",
      continue_from_last: true,
    });
    expect(stubs.run).toHaveBeenCalledTimes(DISPATCH_LIMIT + 1);
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
    expect(stubs.run).toHaveBeenCalledTimes(1);

    finish(finished("completed"));
    await first;
    const third = await tool.execute("call-3", { task: "site two" });
    expect(third.content[0]?.text).toBe("the report");
    expect(stubs.run).toHaveBeenCalledTimes(2);
  });
});
