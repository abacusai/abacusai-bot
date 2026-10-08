import { describe, expect, it, vi } from "vitest";

/**
 * The routine lane on the hosted bot: one start per run, a fresh unattended
 * run, and the answer handed back; nothing at all said for a failure or a
 * run past its deadline, and setup that does nothing on an old server.
 */
import type { CronJob } from "#main/services/agent-tools/cron-store";
import type { HostedRunRequest } from "#main/services/agent-tools/hosted-run";

import {
  setUpHostedRoutines,
  stopIfMigrated,
  type HostedRoutinesSetupDeps,
} from "./hosted-routines-setup";
import { RoutineEntryRunner, type UnattendedRunResult } from "./routine-runner";

const ENTRY = {
  kind: "routine",
  handle: "h1",
  routine: {
    run_key: "rk1",
    name: "Flight price",
    prompt: "Is it under 5000?",
    notify: "relevant",
    deadline_in: 900,
    source_urls: ["https://shop.example/"],
    connector_reads: ["gmail.search"],
    watch_url: "https://shop.example/f/1",
    tz: "Asia/Kolkata",
  },
};

const runner = (options: {
  start?: string;
  result?: UnattendedRunResult;
  throws?: boolean;
}) => {
  const calls: Array<Record<string, unknown>> = [];
  const call = vi.fn(async (body: Record<string, unknown>) => {
    calls.push(body);
    if (body.action === "routine_start")
      return { result: options.start ?? "ok" } as never;
    return {} as never;
  });
  const run = vi.fn(async (_request: HostedRunRequest) => {
    if (options.throws === true) throw new Error("boom");
    return options.result ?? { outcome: "completed" as const, text: "" };
  });
  const activity = vi.fn();
  const lane = new RoutineEntryRunner({
    call: call as never,
    hasKey: () => true,
    run,
    activity,
    log: () => {},
  });
  return { lane, calls, run, activity };
};

describe("the routine lane", () => {
  it("starts the run, runs it unattended with its reach, and hands back the answer", async () => {
    const { lane, calls, run, activity } = runner({
      result: {
        outcome: "completed",
        text: 'Checked.\n{"deliver": true, "text": "It is 4,800 now"}',
      },
    });
    lane.take(ENTRY);
    expect(lane.busy).toBe(true);
    await lane.idle();
    expect(lane.busy).toBe(false);
    expect(run.mock.calls[0]![0]).toMatchObject({
      runKey: "rk1",
      sources: ["https://shop.example/"],
      reads: ["gmail.search"],
      watchUrl: "https://shop.example/f/1",
      notify: "relevant",
      deadlineSecs: 900,
    });
    expect(calls).toEqual([
      { action: "routine_start", handle: "h1" },
      {
        action: "routine_result",
        handle: "h1",
        deliver: true,
        text: "It is 4,800 now",
      },
    ]);
    expect(activity).toHaveBeenCalled();
  });

  it("drops a run the server says already started", async () => {
    const { lane, calls, run } = runner({ start: "duplicate" });
    lane.take(ENTRY);
    await lane.idle();
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual([{ action: "routine_start", handle: "h1" }]);
  });

  it("takes one handle once, however often it arrives", async () => {
    const { lane, run } = runner({});
    lane.take(ENTRY);
    lane.take(ENTRY);
    await lane.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("says nothing for a run past its deadline", async () => {
    const { lane, calls } = runner({
      result: { outcome: "timeout", text: "half" },
    });
    lane.take(ENTRY);
    await lane.idle();
    expect(calls.map((body) => body.action)).toEqual(["routine_start"]);
  });

  it("reports a failure, credits apart, and never delivers it", async () => {
    const credits = runner({
      result: { outcome: "failed", text: "", creditsOut: true },
    });
    credits.lane.take(ENTRY);
    await credits.lane.idle();
    expect(credits.calls[1]).toEqual({
      action: "routine_result",
      handle: "h1",
      deliver: false,
      text: "",
      failure: "payment_required",
    });
    const thrown = runner({ throws: true });
    thrown.lane.take(ENTRY);
    await thrown.lane.idle();
    expect(thrown.calls[1]).toMatchObject({
      deliver: false,
      failure: "failed",
    });
  });

  it("tries the answer again until the run's deadline", async () => {
    let tries = 0;
    const calls: string[] = [];
    let clock = 0;
    const lane = new RoutineEntryRunner({
      call: (async (body: Record<string, unknown>) => {
        calls.push(String(body.action));
        if (body.action === "routine_start") return { result: "ok" };
        tries += 1;
        if (tries < 3) throw new Error("fetch failed");
        return { result: "ok" };
      }) as never,
      hasKey: () => true,
      run: async () => ({ outcome: "completed", text: "done" }),
      activity: () => {},
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => {},
    });
    lane.take(ENTRY);
    await lane.idle();
    expect(calls).toEqual([
      "routine_start",
      "routine_result",
      "routine_result",
      "routine_result",
    ]);
  });

  it("says a run that never started is this computer's trouble, not the routine's", async () => {
    const { lane, calls } = runner({
      result: { outcome: "not-started", text: "" },
    });
    lane.take(ENTRY);
    await lane.idle();
    expect(calls[1]).toMatchObject({
      deliver: false,
      failure: "infra_failure",
    });
  });

  it("drops an entry with no routine", async () => {
    const { lane, run } = runner({});
    lane.take({ kind: "routine", handle: "h2", routine: { name: "no key" } });
    await lane.idle();
    expect(run).not.toHaveBeenCalled();
  });

  it("polls its own lane", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let lane: RoutineEntryRunner;
    const call = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      lane.stop();
      return { messages: [] } as never;
    });
    lane = new RoutineEntryRunner({
      call: call as never,
      hasKey: () => true,
      run: vi.fn(),
      activity: () => {},
    });
    lane.start();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ action: "inbox", lane: "routine" });
  });
});

const cronJob = (overrides: Partial<CronJob>): CronJob => ({
  id: "job",
  name: "Digest",
  schedule: null,
  runAt: null,
  webhookToken: null,
  prompt: "Do it",
  workspaceId: null,
  botId: null,
  enabled: true,
  createdAt: 0,
  lastRunAt: null,
  lastResult: null,
  runs: [],
  ...overrides,
});

const setup = (options: {
  capable: boolean;
  /** Ids refused for now (a network failure) and for good (a plan limit). */
  failNow?: string[];
  refuse?: string[];
  marker?: { migratedAt: number; note: string | null } | null;
}) => {
  const jobs = [
    cronJob({ id: "a", schedule: "0 8 * * *" }),
    cronJob({ id: "b", runAt: 1 }),
    cronJob({ id: "c", name: "Webhook", webhookToken: "tok" }),
  ];
  let marker = options.marker ?? null;
  const deps = {
    hasKey: () => true,
    capability: vi.fn(async () => options.capable),
    refresh: vi.fn(async () => []),
    migration: {
      jobs: () => jobs,
      create: vi.fn(async (request: { idempotencyKey: string }) => {
        if (options.failNow?.includes(request.idempotencyKey))
          throw new Error("fetch failed");
        if (options.refuse?.includes(request.idempotencyKey))
          throw Object.assign(new Error("refused"), { code: "plan_limit" });
        return { id: `hosted-${request.idempotencyKey}` };
      }),
      pause: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      moved: (jobId: string, serverId: string) => {
        const job = jobs.find((entry) => entry.id === jobId)!;
        job.serverId = serverId;
        job.enabled = false;
      },
      notMoved: (jobId: string, reason: string) => {
        const job = jobs.find((entry) => entry.id === jobId)!;
        job.notMoved = reason;
        job.enabled = false;
      },
      log: () => {},
    },
    startRunner: vi.fn(),
    stopLocalScheduler: vi.fn(),
    note: vi.fn(),
    readMarker: () => marker,
    writeMarker: vi.fn((next: typeof marker) => {
      marker = next;
    }),
    now: () => 42,
    log: () => {},
    wait: vi.fn(async (_ms: number) => {}),
  } satisfies HostedRoutinesSetupDeps;
  return { deps, jobs, marker: () => marker };
};

describe("server-kept routines on the hosted bot", () => {
  it("changes nothing on an old server: no runner, no move, the scheduler stays", async () => {
    const { deps } = setup({ capable: false });
    let checks = 0;
    expect(await setUpHostedRoutines(deps, () => ++checks > 3)).toBe("stopped");
    expect(deps.startRunner).not.toHaveBeenCalled();
    expect(deps.migration.create).not.toHaveBeenCalled();
    expect(deps.stopLocalScheduler).not.toHaveBeenCalled();
    expect(stopIfMigrated(deps)).toBe(false);
    // Asked again soon, then less often.
    const waits = (deps.wait.mock.calls as unknown as number[][]).map(
      (call) => call[0]
    );
    expect(waits[0]).toBe(30_000);
    expect(waits[1]).toBe(60_000);
  });

  it("starts the lane at once on a host that already moved, whatever the server says now", async () => {
    const { deps } = setup({
      capable: false,
      marker: { migratedAt: 1, note: null },
    });
    expect(await setUpHostedRoutines(deps)).toBe("on");
    expect(deps.startRunner).toHaveBeenCalled();
    expect(deps.capability).not.toHaveBeenCalled();
  });

  it("moves every routine once, then turns the local scheduler off and says so once", async () => {
    const { deps, jobs, marker } = setup({ capable: true });
    expect(await setUpHostedRoutines(deps)).toBe("on");
    expect(deps.startRunner).toHaveBeenCalled();
    expect(jobs.map((job) => [job.id, job.enabled, job.serverId])).toEqual([
      ["a", false, "hosted-a"],
      ["b", false, "hosted-b"],
      ["c", false, "hosted-c"],
    ]);
    expect(deps.stopLocalScheduler).toHaveBeenCalledTimes(1);
    expect(deps.note).toHaveBeenCalledTimes(1);
    expect(deps.note.mock.calls[0]![0]).toMatch(/^\[routines moved\]/);
    expect(deps.note.mock.calls[0]![0]).toContain("1 of them run on a clock");
    expect(marker()).toEqual({ migratedAt: 42, note: null });

    // A restart: nothing moves again, and nothing is said again.
    deps.migration.create.mockClear();
    deps.note.mockClear();
    expect(stopIfMigrated(deps)).toBe(true);
    await setUpHostedRoutines(deps);
    expect(deps.migration.create).not.toHaveBeenCalled();
    expect(deps.note).not.toHaveBeenCalled();
  });

  it("pauses here what the server will never take, says so, and still leaves one scheduler", async () => {
    const { deps, jobs, marker } = setup({ capable: true, refuse: ["c"] });
    await setUpHostedRoutines(deps);
    expect(jobs.find((job) => job.id === "c")).toMatchObject({
      enabled: false,
      notMoved: "plan_limit",
    });
    expect(deps.stopLocalScheduler).toHaveBeenCalledTimes(1);
    expect(marker()?.migratedAt).toBe(42);
    expect(deps.note.mock.calls[0]![0]).toContain('"Webhook" (plan_limit)');
  });

  it("keeps the scheduler for a job that failed for now, and tries again next start", async () => {
    const { deps, jobs, marker } = setup({ capable: true, failNow: ["c"] });
    await setUpHostedRoutines(deps);
    expect(jobs.find((job) => job.id === "c")).toMatchObject({
      enabled: true,
    });
    expect(deps.stopLocalScheduler).not.toHaveBeenCalled();
    expect(marker()).toBeNull();
  });
});
