import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { RoutineRunItem } from "@abacus-ai/contract/contracts";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";
import type { RoutineRun } from "@abacus-ai/contract/routines";
import { describe, expect, it, vi } from "vitest";

import {
  CreditThresholdWatch,
  markAfterRead,
  settledTurnListener,
} from "../providers/credit-thresholds";
import {
  creditWallOf,
  wallAfterAccountRead,
  wallAfterError,
  wallMoved,
} from "../providers/credit-wall";
import {
  agentRunWarning,
  consecutiveFailures,
  hasRunInFlight,
  NetworkWaitClock,
  ranOutOfAbacusCredits,
  ROUTINE_FAILURES_BEFORE_PAUSE,
  runOutcomeOf,
  shouldPauseAfter,
  stuckRuns,
} from "./routine-guards";
import { readRoutineTiming } from "./routine-timing";

const run = (
  outcome: RoutineRunItem["outcome"],
  startedAt = "2026-09-03T09:00:00.000Z"
): RoutineRunItem => ({
  sessionId: `s-${startedAt}-${outcome}`,
  workspaceId: "w",
  startedAt,
  updatedAt: startedAt,
  outcome,
  trigger: "schedule",
});

describe("the overlap guard", () => {
  it("sees a run still going", () => {
    expect(hasRunInFlight([run("completed"), run("running")])).toBe(true);
    expect(hasRunInFlight([run("completed"), run("failed")])).toBe(false);
    expect(hasRunInFlight([])).toBe(false);
  });
});

describe("the stuck-run timeout", () => {
  it("names only the running runs past the limit", () => {
    const now = new Date("2026-09-03T10:00:00.000Z").getTime();
    const stuck = stuckRuns(
      [
        run("running", "2026-09-03T09:00:00.000Z"),
        run("running", "2026-09-03T09:50:00.000Z"),
        run("completed", "2026-09-03T08:00:00.000Z"),
      ],
      now,
      30 * 60 * 1000
    );
    expect(stuck.map((r) => r.startedAt)).toEqual(["2026-09-03T09:00:00.000Z"]);
  });
  it("does not count time spent waiting for the network", () => {
    const start = new Date("2026-09-03T09:00:00.000Z").getTime();
    const waiting = run("running", "2026-09-03T09:00:00.000Z");
    const clock = new NetworkWaitClock();
    clock.note(waiting.sessionId, true, start + 5 * 60_000);
    const now = start + 50 * 60_000;

    // Forty-five minutes into a wait: still within its allowance, not stuck.
    expect(
      stuckRuns([waiting], now, 30 * 60_000, (id) => clock.waitedMs(id, now))
    ).toEqual([]);

    // The network came back at 0:25; the run's own clock is 30 minutes again.
    clock.note(waiting.sessionId, false, start + 25 * 60_000);
    expect(clock.waitedMs(waiting.sessionId, now)).toBe(20 * 60_000);
    expect(
      stuckRuns([waiting], now, 30 * 60_000, (id) => clock.waitedMs(id, now))
    ).toEqual([]);
    const later = start + 51 * 60_000;
    expect(
      stuckRuns([waiting], later, 30 * 60_000, (id) =>
        clock.waitedMs(id, later)
      )
    ).toEqual([waiting]);
  });
});

describe("the failure streak", () => {
  // Newest first, the way the runs list comes.
  it("counts failures from the newest finished run back", () => {
    expect(
      consecutiveFailures([run("failed"), run("failed"), run("completed")])
    ).toBe(2);
    expect(consecutiveFailures([run("completed"), run("failed")])).toBe(0);
    // A run still going does not break or extend the streak.
    expect(
      consecutiveFailures([run("running"), run("failed"), run("failed")])
    ).toBe(2);
  });

  it("pauses at the threshold and not before", () => {
    const failures = Array.from({ length: ROUTINE_FAILURES_BEFORE_PAUSE }, () =>
      run("failed")
    );
    expect(shouldPauseAfter(failures)).toBe(true);
    expect(shouldPauseAfter(failures.slice(1))).toBe(false);
  });
});

describe("the out-of-credits pause", () => {
  it("fires only on the upgrade the agent offers for Abacus.AI credits", () => {
    expect(
      ranOutOfAbacusCredits({
        actions: [{ type: "switch-model" }, { type: "upgrade-abacus" }],
      })
    ).toBe(true);
    expect(ranOutOfAbacusCredits({ actions: [{ type: "switch-model" }] })).toBe(
      false
    );
    expect(ranOutOfAbacusCredits({})).toBe(false);
  });
});

describe("a run the network let down", () => {
  it("is filed offline, apart from a failure", () => {
    expect(
      runOutcomeOf({ kind: "failed", error: { code: "network_unreachable" } })
    ).toBe("offline");
    expect(
      runOutcomeOf({ kind: "failed", error: { code: "turn_failed" } })
    ).toBe("failed");
    expect(runOutcomeOf({ kind: "reply" })).toBe("completed");
    expect(runOutcomeOf({ kind: "timed_out" })).toBe("failed");
  });

  it("never counts toward the pause, nor breaks a real streak", () => {
    const offline = Array.from({ length: 5 }, () => run("offline"));
    expect(shouldPauseAfter(offline)).toBe(false);
    expect(
      consecutiveFailures([
        run("failed"),
        run("offline"),
        run("failed"),
        run("offline"),
        run("completed"),
      ])
    ).toBe(2);
  });
});

describe("the credit wall a routine meets", () => {
  const row = (patch: Partial<PrefsRow> = {}): PrefsRow =>
    ({
      id: "app",
      creditsExhaustedAt: null,
      freeLaneChosenAt: null,
      ...patch,
    }) as PrefsRow;
  const WALL = { actions: [{ type: "upgrade-abacus", cause: "exhausted" }] };
  const DAY = 24 * 60 * 60_000;

  it("is stamped for the next launch's card whoever met it, a routine with nobody watching included", () => {
    expect(wallAfterError(row(), WALL, 5_000)).toEqual({
      creditsExhaustedAt: 5_000,
      freeLaneChosenAt: null,
    });
    // The first refusal of the day stands; other failures stamp nothing.
    expect(
      wallAfterError(row({ creditsExhaustedAt: 1_000 }), WALL, 5_000)
    ).toBeNull();
    expect(
      wallAfterError(row(), { actions: [{ type: "switch-model" }] }, 5_000)
    ).toBeNull();
    // A day on, it is a new wall, and the choice is asked for again.
    expect(
      wallAfterError(
        row({ creditsExhaustedAt: 1_000, freeLaneChosenAt: 1_000 }),
        WALL,
        1_000 + DAY
      )
    ).toEqual({ creditsExhaustedAt: 1_000 + DAY, freeLaneChosenAt: null });
  });

  it("lifts once a fresh account read shows credits again", () => {
    const wall = row({ creditsExhaustedAt: 1_000, freeLaneChosenAt: 2_000 });
    const read = (remaining: number, at: number) => ({
      remaining,
      granted: 2000,
      at,
    });
    expect(wallAfterAccountRead(wall, read(0, 1_000 + DAY))).toBeNull();
    // Too soon after the wall: the platform's cached account can lag.
    expect(wallAfterAccountRead(wall, read(500, 2_000))).toBeNull();
    expect(wallAfterAccountRead(wall, read(500, 1_000 + 10 * 60_000))).toEqual({
      creditsExhaustedAt: null,
      freeLaneChosenAt: null,
    });
  });

  it("tells every agent when it moves, and only then", () => {
    expect(wallMoved(row({ creditsExhaustedAt: 1 }), row())).toBe(true);
    expect(wallMoved(row({ freeLaneChosenAt: 2 }), row())).toBe(true);
    expect(
      wallMoved(row({ creditsExhaustedAt: 1 }), row({ creditsExhaustedAt: 1 }))
    ).toBe(false);
    expect(creditWallOf(row({ creditsExhaustedAt: 1 }))).toEqual({
      exhaustedAt: 1,
      freeLaneChosenAt: null,
    });
  });
});

describe("when a routine the agent asks for fires", () => {
  const NOW = new Date(2026, 9, 20, 10, 0).getTime();
  const read = (args: Record<string, unknown>) => readRoutineTiming(args, NOW);

  it("takes a schedule or a moment as written, with nothing to say", () => {
    expect(read({ schedule: "0 9 * * *" })).toEqual({
      schedule: "0 9 * * *",
      runAt: null,
      runAtText: null,
      warnings: [],
    });
    const at = read({ run_at: "2026-10-20T18:30" });
    expect(at.runAt).toBe(new Date(2026, 9, 20, 18, 30).getTime());
    // The user's words go to the hosted server as written.
    expect(at.runAtText).toBe("2026-10-20T18:30");
    expect(at.warnings).toEqual([]);
    expect(read({ in_minutes: 10 }).runAt).toBe(NOW + 10 * 60_000);
  });

  it("keeps an every-minute schedule, and warns what it costs", () => {
    const timing = read({ schedule: "* * * * *" });
    expect(timing.schedule).toBe("* * * * *");
    expect(timing.warnings.join(" ")).toContain("fires every minute");
    expect(timing.warnings.join(" ")).toContain("in_minutes");
    expect(read({ schedule: " */1 * * * * " }).warnings).toHaveLength(1);
    for (const slower of ["*/5 * * * *", "* 9 * * *", "0 9 14 2 *"])
      expect(read({ schedule: slower }).warnings).toEqual([]);
  });

  it("uses run_at when in_minutes is given too, and says so", () => {
    const timing = read({ run_at: "2026-10-20T18:30", in_minutes: 5 });
    expect(timing.runAt).toBe(new Date(2026, 9, 20, 18, 30).getTime());
    expect(timing.warnings).toEqual([
      "Both run_at and in_minutes were given: run_at was used.",
    ]);
  });

  it("runs a moment that has passed once now, and says so", () => {
    const timing = read({ run_at: "2026-10-19T08:00" });
    expect(timing.runAt).toBe(NOW);
    expect(timing.runAtText).toBe(new Date(NOW).toISOString());
    expect(timing.warnings.join(" ")).toContain("runs once now");
  });

  it("reads a date with no time as the morning, and says so", () => {
    const timing = read({ run_at: "2026-10-21" });
    expect(timing.runAt).toBe(new Date(2026, 9, 21, 9).getTime());
    expect(timing.warnings.join(" ")).toContain("has no time");
  });

  it("lets a one-time moment win over a schedule given with it", () => {
    const timing = read({ schedule: "0 9 * * *", in_minutes: 30 });
    expect(timing.schedule).toBeNull();
    expect(timing.runAt).toBe(NOW + 30 * 60_000);
    expect(timing.warnings.join(" ")).toContain("the schedule was left out");
  });

  it("leaves out what cannot be read, and says so", () => {
    expect(read({ run_at: "soon" }).runAt).toBeNull();
    expect(read({ run_at: "soon" }).warnings.join(" ")).toContain("left out");
    expect(read({ in_minutes: -3 }).runAt).toBeNull();
    expect(read({ in_minutes: -3 }).warnings).toHaveLength(1);
  });
});

describe("the agent running a routine again", () => {
  const NOW = 1_000_000_000_000;
  const started = (minutesAgo: number, trigger: string) =>
    ({
      kind: "started",
      at: NOW - minutesAgo * 60_000,
      trigger,
    }) as RoutineRun;

  it("says nothing about a run long after the last", () => {
    expect(agentRunWarning([started(120, "schedule")], NOW)).toBeNull();
    expect(agentRunWarning([], NOW)).toBeNull();
  });

  it("warns, never refuses, soon after another run or past a few a day", () => {
    expect(agentRunWarning([started(4, "schedule")], NOW)).toBe(
      "This routine already ran 4 minutes ago. Running it again repeats what it sends and spends credits: do not run it again unless the user asked."
    );
    expect(
      agentRunWarning(
        [started(30, "agent"), started(60, "agent"), started(90, "agent")],
        NOW
      )
    ).toMatch(/you have run it 3 times today/i);
  });
});

describe("the free grant's credit milestones", () => {
  const ACCOUNT = {
    user_id: "u1",
    organization_id: "o1",
    subscription_tier: "free",
    credits_granted: 2000,
    credits_used: 0,
  };
  const KEY = "o1:u1";
  const setup = (
    tellInChat: (
      sessionId: string,
      mark: CreditThresholdMark
    ) => Promise<boolean> = vi.fn(async () => false),
    retriesUntold?: (sessionId: string) => boolean
  ) => {
    let row = { id: "app", creditThresholds: {} } as unknown as PrefsRow;
    const account = { ...ACCOUNT };
    const clock = { now: new Date(2026, 9, 22, 10).getTime() };
    const watch = new CreditThresholdWatch({
      prefs: () => ({
        get: () => row,
        update: (patch: PrefsPatch) => {
          row = { ...row, ...patch } as PrefsRow;
        },
      }),
      readAccount: async () => ({ ...account }) as never,
      tellInChat,
      ...(retriesUntold != null ? { retriesUntold } : {}),
      now: () => clock.now,
    });
    const settle = async (
      used: number,
      kind: "build" | "message" = "build"
    ) => {
      account.credits_used = used;
      clock.now += 60_000;
      await watch.turnSettled("s1", kind);
      return row.creditThresholds?.[KEY];
    };
    return {
      watch,
      settle,
      account,
      tellInChat,
      mark: () => row.creditThresholds?.[KEY],
    };
  };

  it("stamps half, then four fifths, each once", async () => {
    const h = setup();
    expect(await h.settle(900)).toBeUndefined();
    const half = await h.settle(1000);
    expect(half).toMatchObject({ reached: 50, used: 1000, granted: 2000 });
    expect(await h.settle(1200)).toBe(half);
    expect(await h.settle(1600)).toMatchObject({ reached: 80, used: 1600 });
    const low = h.mark();
    expect(await h.settle(1700)).toBe(low);
  });

  it("estimates from today's post-turn reads: credits per completed turn, and what they were", async () => {
    const h = setup();
    await h.settle(800);
    await h.settle(900);
    expect(await h.settle(1000)).toMatchObject({
      reached: 50,
      perTask: 100,
      kind: "builds",
    });
    const mixed = setup();
    await mixed.settle(1000, "message");
    expect(mixed.mark()).toMatchObject({ perTask: null, kind: null });
    await mixed.settle(1300, "build");
    await mixed.settle(1600, "message");
    expect(mixed.mark()).toMatchObject({
      reached: 80,
      perTask: 300,
      kind: "tasks",
    });
  });

  it("never for a paid plan, and not at the whole grant, where the out-of-credits card speaks", async () => {
    const paid = setup();
    paid.account.subscription_tier = "basic";
    expect(await paid.settle(1900)).toBeUndefined();
    const spent = setup();
    expect(await spent.settle(2000)).toBeUndefined();
    expect(
      markAfterRead(undefined, { used: 2400, granted: 2000, at: 1 }, null)
    ).toBeNull();
    // An 80 mark is never stepped back to 50.
    expect(
      markAfterRead(
        { reached: 80 } as CreditThresholdMark,
        { used: 1000, granted: 2000, at: 1 },
        null
      )
    ).toBeNull();
  });

  it("tells a chat-app turn's chat once per threshold and remembers it", async () => {
    const tell = vi.fn(async () => true);
    const h = setup(tell);
    await h.settle(1000);
    await h.settle(1100);
    expect(tell).toHaveBeenCalledTimes(1);
    expect(h.mark()).toMatchObject({ reached: 50, told: 50 });
    await h.settle(1600);
    await h.settle(1700);
    expect(tell).toHaveBeenCalledTimes(2);
    expect(h.mark()).toMatchObject({ reached: 80, told: 80 });
  });

  it("on the WhatsApp number, says a line that did not go again after the next turn, then never again", async () => {
    const tell = vi.fn(
      async (_sessionId: string, _mark: CreditThresholdMark) => false
    );
    const h = setup(tell, () => true);
    await h.settle(1000);
    expect(tell).toHaveBeenCalledTimes(1);
    expect(h.mark()).toMatchObject({ reached: 50, told: null });
    tell.mockResolvedValue(true);
    await h.settle(1100);
    expect(tell).toHaveBeenCalledTimes(2);
    // Said with the account as read now, still as the half line.
    expect(tell.mock.calls[1]![1]).toMatchObject({ reached: 50, used: 1100 });
    expect(h.mark()).toMatchObject({ reached: 50, told: 50 });
    await h.settle(1200);
    expect(tell).toHaveBeenCalledTimes(2);
  });

  it("elsewhere, a line that did not go is left to the card, never said again", async () => {
    const tell = vi.fn(async () => false);
    const h = setup(tell);
    await h.settle(1000);
    tell.mockResolvedValue(true);
    await h.settle(1100);
    expect(tell).toHaveBeenCalledTimes(1);
    expect(h.mark()).toMatchObject({ reached: 50, told: null });
  });

  it("checks only when a billed turn settles, never mid-turn", () => {
    const turnSettled = vi.fn(async () => {});
    const listen = settledTurnListener(
      { turnSettled },
      { onFreePlan: () => true, kindOf: () => "build" }
    );
    const event = (e: Record<string, unknown>) =>
      listen("s1", { type: "event", event: e } as never);
    const usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      requests: 1,
      model: "m",
    };
    // A round of tool calls ends; the turn goes on.
    event({ type: "turn_complete", usage });
    expect(turnSettled).not.toHaveBeenCalled();
    event({ type: "status_changed", status: AgentStatus.Idle });
    expect(turnSettled).toHaveBeenCalledExactlyOnceWith("s1", "build");
    // Idle again with no billed turn, or a turn on the free lane: nothing.
    event({ type: "status_changed", status: AgentStatus.Idle });
    event({ type: "turn_complete", usage: { ...usage, lane: "free" } });
    event({ type: "status_changed", status: AgentStatus.Idle });
    expect(turnSettled).toHaveBeenCalledTimes(1);
  });
});
