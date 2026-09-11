import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The repeat guard breaks loops. It must not break looking again.
 *
 * Its refusal tells the model "repeating it returns the same result", which is
 * true of reading a file and false of photographing a screen. Blocked on a
 * third screenshot, one run concluded the tool was deduplicating its calls and
 * started relaunching the app to "force a state change" rather than simply
 * looking again after a tap.
 */
import { afterEach, describe, expect, it } from "vitest";

import budgets, { budgetStopReason } from "./budgets.js";

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
  it("never blocks a screenshot — taking it again after a tap is the job", async () => {
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
 * call with nothing said: the abort surfaced as "the model provider had a
 * problem — retrying", and it landed on runs that had just handed the work
 * over. Now the model is told to wrap up and present at 100 short, told
 * again at 50 short, and the stop carries a message written for the user.
 */
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

  it("stops past the cap with a message written for the user, not the provider", async () => {
    const { aborts } = await run(250, 251);

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

  it("forgets the stop when the next run starts", async () => {
    const { pi } = await run(250, 251);
    expect(budgetStopReason()).not.toBeNull();

    await pi.fire("agent_start", {});

    expect(budgetStopReason()).toBeNull();
  });
});
