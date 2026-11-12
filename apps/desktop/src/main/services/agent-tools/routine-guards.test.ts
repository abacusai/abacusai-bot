import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { RoutineRunItem } from "@abacus-ai/contract/contracts";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";
import {
  ROUTINE_FAILURES_BEFORE_PAUSE,
  ROUTINE_PAUSE_NOTES,
  ROUTINE_QUIET_RUNS_BEFORE_PAUSE,
  type RoutineRun,
} from "@abacus-ai/contract/routines";
import { describe, expect, it, vi } from "vitest";

import { PrefsStore } from "../config/prefs-store";
import { ConnectivityService } from "../connectivity/connectivity-service";
import {
  CreditThresholdWatch,
  markAfterRead,
  settledTurnListener,
} from "../providers/credit-thresholds";
import {
  creditWallOf,
  routineStopsAtWall,
  wallAfterAccountRead,
  wallAfterError,
  wallReopenAfterError,
  wallReopenAfterWrite,
  wallMoved,
} from "../providers/credit-wall";
import {
  agentRunWarning,
  consecutiveFailures,
  consecutiveQuietRuns,
  hasRunInFlight,
  isQuietReply,
  NetworkWaitClock,
  ranOutOfAbacusCredits,
  runOutcomeOf,
  shouldPauseAfter,
  shouldPauseQuiet,
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
  it("does not count time the machine slept (the power clock)", () => {
    let now = new Date("2026-09-03T09:00:00.000Z").getTime();
    const power = new ConnectivityService({
      probe: async () => true,
      now: () => now,
      log: () => {},
    });
    const running = run("running", "2026-09-03T09:00:00.000Z");
    const stuckAt = (at: number) =>
      stuckRuns(
        [running],
        at,
        30 * 60_000,
        () => 0,
        (from) => power.asleepBetween(from, at)
      );
    now += 10 * 60_000;
    power.suspended();
    now += 40 * 60_000;
    // Asleep 40 minutes into a 30-minute allowance: not stuck, before or at wake.
    expect(stuckAt(now)).toEqual([]);
    power.resumed();
    expect(stuckAt(now)).toEqual([]);
    // Its awake time runs out 20 minutes after the wake, not before.
    expect(stuckAt(now + 19 * 60_000)).toEqual([]);
    expect(stuckAt(now + 21 * 60_000)).toEqual([running]);
    // The wall clock alone (main before the power clock) reaped it at wake.
    expect(stuckRuns([running], now, 30 * 60_000)).toEqual([running]);
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

describe("the quiet-run streak", () => {
  const done = (reply: string) => ({ outcome: "completed", reply });
  const quiet = done("Checked the inbox and the calendar.\nNO_REPLY");

  it("counts runs that ended on NO_REPLY from the newest back", () => {
    expect(isQuietReply("NO_REPLY")).toBe(true);
    expect(isQuietReply("Looked at both feeds. NO_REPLY \n")).toBe(true);
    expect(isQuietReply("Nothing new since 19:33.")).toBe(false);
    expect(isQuietReply("")).toBe(false);
    expect(consecutiveQuietRuns([quiet, quiet, done("A reply came.")])).toBe(2);
    // A failed or offline run neither breaks nor extends it.
    expect(
      consecutiveQuietRuns([
        quiet,
        { outcome: "failed", reply: "" },
        quiet,
        { outcome: "offline", reply: "NO_REPLY" },
        quiet,
      ])
    ).toBe(3);
  });

  it("pauses at the threshold, and never again once the user resumed a quiet pause", () => {
    const runs = Array.from(
      { length: ROUTINE_QUIET_RUNS_BEFORE_PAUSE },
      () => quiet
    );
    expect(shouldPauseQuiet(runs, [], 0)).toBe(true);
    expect(shouldPauseQuiet(runs.slice(1), [], 0)).toBe(false);
    const pausedAt = 1_000;
    const pause: RoutineRun = {
      id: "attempt-p",
      at: pausedAt,
      trigger: "schedule",
      result: ROUTINE_PAUSE_NOTES.quiet,
      kind: "paused",
      sessionId: null,
      attemptId: null,
    };
    expect(shouldPauseQuiet(runs, [pause], pausedAt + 1)).toBe(false);
    // A pause for failures, resumed, does not exempt it.
    expect(
      shouldPauseQuiet(
        runs,
        [{ ...pause, result: "paused after 3 failed runs in a row" }],
        pausedAt + 1
      )
    ).toBe(true);
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
    expect(runOutcomeOf({ kind: "app_closed" })).toBe("interrupted");
  });

  it("never counts toward the pause, nor breaks a real streak", () => {
    const offline = Array.from({ length: 5 }, () => run("offline"));
    expect(shouldPauseAfter(offline)).toBe(false);
    const interrupted = Array.from({ length: 5 }, () => run("interrupted"));
    expect(shouldPauseAfter(interrupted)).toBe(false);
    expect(
      consecutiveFailures([
        run("failed"),
        run("offline"),
        run("failed"),
        run("interrupted"),
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

  it("a wall in the user's own chat is the one asked again on their return; their next words there settle it", () => {
    // Every wall in the user's own chat re-arms the ask, a later one included.
    expect(wallReopenAfterError("s1", WALL, true, 5_000)).toEqual({
      dismissals: {
        wallReopen: { sessionId: "s1", wallAt: 5_000, askedAt: null },
      },
    });
    // A bot's, a routine's or a phone lane's wall, or another failure, is not one.
    expect(wallReopenAfterError("s1", WALL, false, 5_000)).toBeNull();
    expect(
      wallReopenAfterError(
        "s1",
        { actions: [{ type: "switch-model" }] },
        true,
        5_000
      )
    ).toBeNull();
    const walled = row({
      dismissals: {
        wallReopen: { sessionId: "s1", wallAt: 5_000, askedAt: null },
      } as PrefsRow["dismissals"],
    });
    expect(wallReopenAfterWrite(walled, "s1")).toEqual({
      dismissals: { wallReopen: null },
    });
    expect(wallReopenAfterWrite(walled, "s2")).toBeNull();
    // The real store takes both writes, as main makes them.
    const store = new PrefsStore({ file: null });
    store.update(wallReopenAfterError("s1", WALL, true, 5_000)!);
    expect(store.get().dismissals.wallReopen).toEqual({
      sessionId: "s1",
      wallAt: 5_000,
      askedAt: null,
    });
    store.update(wallReopenAfterWrite(store.get(), "s1")!);
    expect(store.get().dismissals.wallReopen).toBeNull();
    expect(
      wallReopenAfterWrite(
        row({ dismissals: {} as PrefsRow["dismissals"] }),
        "s1"
      )
    ).toBeNull();
  });

  it("stops a fire only while the wall stands and the free models were not chosen", () => {
    const empty = { remaining: 0, granted: 100, at: 1_000 };
    const funded = { ...empty, remaining: 40 };
    const stale = 1_000 + DAY + 1;
    const wall = { exhaustedAt: 1_000, freeLaneChosenAt: null };
    expect(routineStopsAtWall(wall, null, 2_000)).toBe(true);
    expect(
      routineStopsAtWall({ ...wall, exhaustedAt: null }, empty, 2_000)
    ).toBe(false);
    expect(
      routineStopsAtWall({ ...wall, freeLaneChosenAt: 1_500 }, null, 2_000)
    ).toBe(false);
    // Past its day the wall is only as good as the account.
    expect(routineStopsAtWall(wall, empty, stale)).toBe(true);
    expect(routineStopsAtWall(wall, funded, stale)).toBe(false);
    expect(routineStopsAtWall(wall, null, stale)).toBe(false);
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
  });

  it("keeps an hourly or faster schedule, and says how many runs a day it spends credits on", () => {
    for (const [schedule, fires] of [
      ["*/5 * * * *", 288],
      ["*/15 * * * *", 96],
      ["*/30 9-17 * * 1-5", 18],
      ["0 * * * *", 24],
      ["* 9 * * *", 60],
    ] as const) {
      const timing = read({ schedule });
      expect(timing.schedule).toBe(schedule);
      if (fires < 24) {
        expect(timing.warnings).toEqual([]);
        continue;
      }
      expect(timing.warnings).toHaveLength(1);
      expect(timing.warnings[0]).toContain(`fires ${fires} times a day`);
      expect(timing.warnings[0]).toContain("spends the user's credits");
    }
    for (const slower of ["0 9 * * *", "0 8,13,18 * * *", "0 9 14 2 *", "bad"])
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

describe("the plan's credit milestones", () => {
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
    // The real store: every stamped mark passes the prefs schema, as in the app.
    const store = new PrefsStore({ file: null });
    const account: Record<string, unknown> = { ...ACCOUNT };
    const clock = { now: new Date(2026, 9, 22, 10).getTime() };
    const watch = new CreditThresholdWatch({
      prefs: () => store,
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
      return store.get().creditThresholds?.[KEY];
    };
    return {
      watch,
      settle,
      account,
      tellInChat,
      mark: () => store.get().creditThresholds?.[KEY],
      card: () => store.get().dismissals.creditThresholdCards?.[KEY],
      answer: (answered: 50 | 80) => {
        store.update({
          dismissals: {
            creditThresholdCards: { [KEY]: { shown: answered, answered } },
          },
        });
      },
    };
  };

  it("stamps half, four fifths, then 95%, each once, and nothing at the whole grant", async () => {
    const h = setup();
    expect(await h.settle(900)).toBeUndefined();
    const half = await h.settle(1000);
    expect(half).toMatchObject({ reached: 50, used: 1000, granted: 2000 });
    expect(await h.settle(1200)).toEqual(half);
    expect(await h.settle(1600)).toMatchObject({ reached: 80, used: 1600 });
    const low = h.mark();
    expect(await h.settle(1700)).toEqual(low);
    expect(await h.settle(1900)).toMatchObject({ reached: 95, used: 1900 });
    const last = h.mark();
    expect(await h.settle(1950)).toEqual(last);
    expect(await h.settle(2000)).toEqual(last);
  });

  it("an upgrade drops the free plan's mark and its answer; the paid plan starts its own afresh", async () => {
    const h = setup();
    expect(await h.settle(1640)).toMatchObject({ reached: 80, plan: "free" });
    h.answer(80);
    h.account.subscription_tier = "basic";
    h.account.credits_granted = 20_000;
    expect(await h.settle(0)).toBeUndefined();
    expect(h.card()).toBeUndefined();
    expect(await h.settle(10_000)).toMatchObject({
      reached: 50,
      plan: "paid",
      granted: 20_000,
    });
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

  it("a paid plan's against its monthly credits, never what was bought on top", async () => {
    const paid = setup();
    // 20,000 a month plus 10,000 bought: low only once below the plan's own.
    Object.assign(paid.account, {
      subscription_tier: "basic",
      credits_granted: 30_000,
      plan_credits: 20_000,
    });
    expect(await paid.settle(15_000)).toBeUndefined();
    expect(await paid.settle(20_000)).toMatchObject({
      reached: 50,
      used: 10_000,
      granted: 20_000,
    });
    expect(await paid.settle(26_500)).toMatchObject({ reached: 80 });
    // An unread plan is not guessed at.
    const unknown = setup();
    unknown.account.subscription_tier = null;
    expect(await unknown.settle(1900)).toBeUndefined();
  });

  it("a paid plan's new month clears the mark: the next spend-down warns again", async () => {
    const h = setup();
    h.account.subscription_tier = "pro";
    await h.settle(1700);
    h.answer(80);
    expect(h.mark()).toMatchObject({ reached: 80, plan: "paid" });
    // The month renews: the mark and the card's answer go, nothing is owed.
    expect(await h.settle(0)).toBeUndefined();
    expect(h.card()).toBeUndefined();
    expect(await h.settle(1100)).toMatchObject({ reached: 50 });
  });

  it("a partial top-up brings back no card; spending down again warns at four fifths", async () => {
    const h = setup();
    Object.assign(h.account, { subscription_tier: "pro", plan_credits: 2000 });
    await h.settle(1700);
    h.answer(80);
    // 5% of the plan bought: 70% of it used, so the mark moves down, answered.
    h.account.credits_granted = 2300;
    expect(await h.settle(1700)).toMatchObject({ reached: 50, plan: "paid" });
    expect(h.card()).toEqual({ shown: 50, answered: 50 });
    // Back to four fifths of the plan: the 80% card is owed again.
    expect(await h.settle(1900)).toMatchObject({ reached: 80 });
    expect(h.card()).toEqual({ shown: 50, answered: 50 });
  });

  it("the free plan's one-time grant never re-arms, as before", async () => {
    const h = setup();
    await h.settle(1700);
    h.answer(80);
    h.account.credits_granted = 4000;
    await h.settle(1700);
    expect(h.mark()).toMatchObject({ reached: 80, plan: "free" });
    expect(h.card()).toEqual({ shown: 80, answered: 80 });
  });

  it("a team or enterprise plan, with no top-up of its own, gets no milestones", async () => {
    for (const tier of ["enterprise", "team", "business"]) {
      const h = setup();
      h.account.subscription_tier = tier;
      expect(await h.settle(1700)).toBeUndefined();
    }
  });

  it("not at the whole grant, where the out-of-credits card speaks", async () => {
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
      { kindOf: () => "build" }
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
