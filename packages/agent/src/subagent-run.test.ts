import { describe, expect, it, vi } from "vitest";

import {
  budgetNote,
  CLOSING_MESSAGE,
  closeOut,
  finalWarningMessage,
  makerVoice,
  runSubagent,
  SUBAGENT_TURNS,
  type SubagentSession,
  TurnBudget,
  wrapUpMessage,
} from "./subagent-run.js";

/** Every step a budget takes, by turn. */
const run = (budget: TurnBudget, turns: number) =>
  Array.from({ length: turns }, () => budget.endTurn());

describe("the turn budget", () => {
  it("asks for the report before the hard ceiling", () => {
    expect(SUBAGENT_TURNS.wrapUp).toBeLessThan(SUBAGENT_TURNS.finalWarning);
    expect(SUBAGENT_TURNS.finalWarning).toBeLessThan(SUBAGENT_TURNS.max);
  });

  it("warns once at each point, then stops at the ceiling", () => {
    const steps = run(
      new TurnBudget({ max: 10, wrapUp: 4, finalWarning: 7 }),
      10
    );

    expect(steps.map((step) => step.kind)).toEqual([
      "continue",
      "continue",
      "continue",
      "steer",
      "continue",
      "continue",
      "steer",
      "continue",
      "continue",
      "exhausted",
    ]);
    expect(steps[3]).toMatchObject({
      reason: "wrap-up",
      text: wrapUpMessage(6),
    });
    expect(steps[6]).toMatchObject({
      reason: "final",
      text: finalWarningMessage(3),
    });
  });

  it("does not repeat a wrap-up that was asked for early", () => {
    const budget = new TurnBudget({ max: 10, wrapUp: 4, finalWarning: 7 });

    expect(budget.wrapUp()?.kind).toBe("steer");
    expect(budget.wrapUp()).toBeNull();
    expect(run(budget, 6).some((step) => step.kind === "steer")).toBe(false);
  });

  it("sends only the final warning when both points fall on one turn", () => {
    const steps = run(
      new TurnBudget({ max: 10, wrapUp: 5, finalWarning: 5 }),
      10
    );

    expect(steps.filter((step) => step.kind === "steer")).toEqual([
      expect.objectContaining({ reason: "final" }),
    ]);
  });

  it("tells the run how many turns it has, not that it is 'close to a limit'", () => {
    // "close to your limit" reads as "out of budget" to a small model; it then
    // reports at once, and a resumed run reports before it does anything.
    expect(wrapUpMessage(40)).toMatch(/40 turns/);
    expect(wrapUpMessage(40)).not.toMatch(/close to/i);
    expect(finalWarningMessage(15)).toMatch(/15 turns/);
    expect(new TurnBudget().note()).toBe(budgetNote(SUBAGENT_TURNS.max));
    expect(budgetNote(100)).toMatch(/100 tool turns/);
  });
});

describe("the warnings for a run that makes a file", () => {
  const steps = run(
    new TurnBudget(
      { max: 10, wrapUp: 4, finalWarning: 7 },
      makerVoice("render_deck")
    ),
    10
  ).filter((step) => step.kind === "steer");

  it("ask it to finish and render, not to stop and report", () => {
    // "Stop exploring and report" abandons a half-built deck; an unrendered
    // draft is lost when the budget runs out.
    for (const step of steps) {
      expect(step).toMatchObject({
        text: expect.stringContaining("render_deck"),
      });
      expect(step).not.toMatchObject({
        text: expect.stringMatching(/stop exploring/i),
      });
    }
    expect(steps[0]).toMatchObject({
      text: expect.stringMatching(/about 6 turns left/),
    });
    expect(steps[1]).toMatchObject({
      text: expect.stringMatching(/3 turns left/),
    });
  });
});

/** A session whose closing turn writes `reply`, recording what was done to it. */
function fakeSession(reply: string | null) {
  const calls: string[] = [];
  let listener: ((event: never) => void) | null = null;
  const session: SubagentSession = {
    subscribe: (next) => {
      listener = next as never;
      return () => {
        listener = null;
      };
    },
    prompt: vi.fn(async (text: string) => {
      calls.push(`prompt:${text === CLOSING_MESSAGE ? "closing" : text}`);
      if (reply == null) return new Promise<void>(() => undefined);
      listener?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: reply }],
        },
      } as never);
    }),
    steer: async () => undefined,
    abort: async () => {
      calls.push("abort");
    },
    clearQueue: () => {
      calls.push("clearQueue");
    },
    setActiveToolsByName: (names) => {
      calls.push(`tools:${names.join(",")}`);
    },
  };
  return { session, calls };
}

describe("closing out a run that is out of budget", () => {
  it("stops the run, turns every tool off, and asks for the report", async () => {
    const { session, calls } = fakeSession("what I found");

    expect(await closeOut(session)).toBe("what I found");
    expect(calls).toEqual([
      "abort",
      "clearQueue",
      "tools:",
      "prompt:closing",
      "abort",
    ]);
  });

  it("gives up on a model that does not answer", async () => {
    const { session } = fakeSession(null);

    expect(await closeOut(session, undefined, 20)).toBe("");
  });

  it("does nothing when no time is left for it", async () => {
    const { session, calls } = fakeSession("ignored");

    expect(await closeOut(session, undefined, 0)).toBe("");
    expect(calls).toEqual([]);
  });

  it("does nothing once the user has stopped the run", async () => {
    const { session, calls } = fakeSession("ignored");
    const controller = new AbortController();
    controller.abort();

    expect(await closeOut(session, controller.signal)).toBe("");
    expect(calls).toEqual([]);
  });
});

describe("a run that hits its time limit", () => {
  it("closes out within the limit, not after it", async () => {
    // Works forever until aborted, then answers the closing prompt.
    const { session } = fakeSession("closing report");
    const working = session.prompt;
    let first = true;
    session.prompt = (text: string) => {
      if (first) {
        first = false;
        return new Promise<void>(() => undefined);
      }
      return working(text);
    };

    const started = Date.now();
    const result = await runSubagent(session, "work", {
      tag: "test",
      forwardTools: Object.assign(() => false, { settle: () => undefined }),
      timeoutMs: 400,
    });

    expect(result.stoppedBy).toBe("timeout");
    expect(result.text).toBe("closing report");
    // Far under the 90s a closing turn used to add on top; slack for slow CI.
    expect(Date.now() - started).toBeLessThan(400 + 2000);
  });
});
