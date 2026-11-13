import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { ROUTINE_PAUSE_NOTES } from "@abacus-ai/contract/routines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./rpc/testing";
import {
  createJob,
  listJobs,
  updateJob,
} from "./services/agent-tools/cron-store";
import { HostedRoutineRefusal } from "./services/agent-tools/hosted-routines";
import { buildRoutineFirePrompt } from "./services/agent-tools/routine-prompt";
import { McpAgentToolsServer } from "./services/mcp/mcp-agent-tools-server";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    { default: anything },
    {
      get: (target, property) =>
        property in target
          ? (target as Record<PropertyKey, unknown>)[property]
          : property === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});
const account = vi.hoisted(() => vi.fn());
const tier = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("./services/providers/abacus", async (original) => ({
  ...(await original<typeof import("./services/providers/abacus")>()),
  fetchAbacusAccount: account,
  cachedAbacusAccount: () =>
    tier.current == null ? null : { subscription_tier: tier.current },
}));
const catalog = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  reads: 0,
}));
vi.mock("./services/providers/models", async (original) => ({
  ...(await original<typeof import("./services/providers/models")>()),
  listAvailableModels: async () => {
    catalog.reads += 1;
    return catalog.rows;
  },
  cachedRecommendedModelId: () => "openllm/auto",
}));
// The sessions' records, kept across the launches a test makes.
const sessionRecords = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./services/session/workspace-store", () => ({
  workspaceStore: {
    get: (key: string) => sessionRecords.get(key),
    set: (key: string, value: unknown) => sessionRecords.set(key, value),
  },
}));
const { ServiceHost } = await import("./service-host");
const { createBot } = await import("./services/bots/bot-store");
const { setDefaultModel } = await import("./services/config/settings");
const { newRoutineModel } = await import("./services/providers/session-model");
let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "routine-plan-"));
  process.env.ABACUSAI_BOT_HOME = home;
  account.mockReset();
  account.mockResolvedValue({ subscription_tier: "free", plan: null });
  tier.current = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const host = (hostedOnly = false, platform = "web-host") =>
  Object.assign(
    { createRoutine: ServiceHost.prototype.createRoutine },
    {
      platform,
      hostedOnly: () => hostedOnly,
      defaultRoutineRunner: () => "local",
      hostedRoutines: {
        capability: vi.fn(async () => true),
        create: vi.fn(async () => ({ id: "server-routine" })),
        list: () => [],
        refresh: async () => [],
      },
      emitEvent: vi.fn(),
      webhookRelay: { refreshNow: vi.fn() },
    }
  );
const input = {
  prompt: "Send a daily digest",
  schedule: "0 9 * * *",
  webhook: true,
};
const assertNoCreation = (service: ReturnType<typeof host>) => {
  expect(listJobs()).toEqual([]);
  expect(service.hostedRoutines.create).not.toHaveBeenCalled();
  expect(service.hostedRoutines.capability).not.toHaveBeenCalled();
  expect(service.emitEvent).not.toHaveBeenCalled();
  expect(service.webhookRelay.refreshNow).not.toHaveBeenCalled();
};
describe("routine creation plan admission", () => {
  it.each(["local", "hosted"] as const)(
    "blocks free %s insertion through the real RPC without persisting the optimistic id",
    async (runner) => {
      const service = host(runner === "hosted");
      const connection = connectInProcess(
        fakeDeps({
          serviceHost: { createRoutine: service.createRoutine.bind(service) },
        })
      );
      try {
        await expect(
          connection.client.db.routines.insert({
            ...input,
            runner,
            id: "optimistic-free",
          })
        ).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          data: { reason: "plan-required" },
        });
        assertNoCreation(service);
      } finally {
        connection.closeClient();
        connection.closeServer();
      }
    }
  );
  it.each([
    { subscription_tier: "  FrEe  ", plan: "Pro" },
    { subscription_tier: null, plan: "Free" },
    { subscription_tier: "", plan: "Free" },
    { subscription_tier: "  ", plan: " Free " },
  ])("recognizes a known free plan from %j", async (value) => {
    account.mockResolvedValue(value);
    const service = host();
    await expect(service.createRoutine(input)).rejects.toBeInstanceOf(
      HostedRoutineRefusal
    );
    assertNoCreation(service);
  });
  it.each(["local", "hosted"] as const)(
    "blocks agent cronjob creation with %s runner without a job or delivery",
    async (runner) => {
      const service = host(runner === "hosted");
      const server = new McpAgentToolsServer({
        skillsService: {} as never,
        enabledToolsets: () => new Set(["cronjob"]),
        workspacePath: () => null,
        workspaceId: () => null,
        botIdForSession: () => null,
        sessionRole: () => null,
        routines: {
          defaultRunner: () => runner,
          hostedOnly: () => runner === "hosted",
          create: (request, options) =>
            service.createRoutine(request, undefined, options),
          hosted: service.hostedRoutines,
        },
      } as never);
      const result = (await server.executeTool(
        "cronjob",
        { action: "create", ...input, runner },
        "session-test"
      )) as { content: Array<{ text?: string }> };
      const note = result.content.map((part) => part.text).join("\n");
      expect(note).toContain("Routines require a paid plan");
      expect(note).not.toContain("includes one routine");
      expect(note).not.toContain("already has it");
      assertNoCreation(service);
    }
  );
  it.each([
    { subscription_tier: "Pro", plan: "Free" },
    { subscription_tier: null, plan: "Enterprise" },
    null,
    { subscription_tier: null, plan: null },
  ])(
    "preserves local creation for paid, BYOK, and unknown account %j",
    async (value) => {
      account.mockResolvedValue(value as Partial<AbacusAccountInfo> | null);
      const service = host();
      const created = await service.createRoutine(input, "local-allowed");
      expect(created.id).toBe("local-allowed");
      expect(listJobs()).toHaveLength(1);
      expect(service.emitEvent).toHaveBeenCalledTimes(1);
      expect(service.webhookRelay.refreshNow).toHaveBeenCalledTimes(1);
      expect(service.hostedRoutines.create).not.toHaveBeenCalled();
    }
  );
  it("keeps free creation on desktop", async () => {
    const service = host(false, "electron");
    const created = await service.createRoutine(input, "desktop-free");
    expect(created.id).toBe("desktop-free");
    expect(listJobs()).toHaveLength(1);
  });
  it("preserves paid hosted creation and agent provenance", async () => {
    account.mockResolvedValue({ subscription_tier: "pro" });
    const service = host(true);
    await expect(
      service.createRoutine(input, "paid-create", { byAgent: true })
    ).resolves.toEqual({ id: "server-routine" });
    expect(service.hostedRoutines.create).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "paid-create",
        createdBy: "agent",
      })
    );
    expect(listJobs()).toEqual([]);
  });
});

describe("a routine run the network let down", () => {
  /** The run's turn closing, as the TurnLedger hands it over. */
  const settle = (service: object, ending: Record<string, unknown>): void =>
    (
      ServiceHost.prototype as unknown as {
        settleRoutineRun: (record: unknown) => void;
      }
    ).settleRoutineRun.call(service, {
      turnId: "t1",
      sessionId: "run-1",
      startedAt: 0,
      endedAt: 1,
      ...ending,
    });

  it("is filed offline, and never pauses the routine", async () => {
    const { createJob } = await import("./services/agent-tools/cron-store");
    const { NetworkWaitClock } =
      await import("./services/agent-tools/routine-guards");
    const { readLastRoutineRun } =
      await import("./services/agent-tools/routine-runs-store");
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    const dir = path.join(home, "routine-home");
    const outcomes: string[] = [];
    const service = {
      agentSessionManagerService: {
        isRoutineSession: () => true,
        setRunOutcome: (_id: string, outcome: string) => {
          if (outcomes.at(-1) === "offline" && outcome === "completed")
            return false;
          outcomes.push(outcome);
          return true;
        },
        get: () => ({ routineId: job.id, createdAt: "2026-10-13T09:00:00Z" }),
      },
      routineNetworkWaits: new NetworkWaitClock(),
      workWaiting: { routineRan: vi.fn() },
      routineRunText: new Map([["run-1", []]]),
      routineHome: () => dir,
      pauseRoutine: vi.fn(),
      pauseIfFailingRepeatedly: vi.fn(),
    };

    settle(service, {
      kind: "failed",
      cause: "network_unreachable",
      error: {
        message: "Couldn't reach Abacus — check your connection.",
        code: "network_unreachable",
      },
    });

    expect(outcomes).toEqual(["offline"]);
    expect(readLastRoutineRun(dir)?.outcome).toBe("offline");
    expect(service.pauseRoutine).not.toHaveBeenCalled();
    expect(service.pauseIfFailingRepeatedly).not.toHaveBeenCalled();
  });
});

describe("a routine whose runs keep finding nothing", () => {
  const proto = ServiceHost.prototype as unknown as {
    settleRoutineRun: (record: unknown) => void;
    pauseIfQuietRepeatedly: (routineId: string) => void;
    pauseRoutine: (routineId: string, reason: string) => void;
  };

  /** Settles one run of the routine, saying `reply`, started just now. */
  const runner = (routineId: string, dir: string) => {
    const text = new Map<string, string[]>();
    const startedAt = new Map<string, string>();
    let count = 0;
    const service = {
      agentSessionManagerService: {
        isRoutineSession: () => true,
        setRunOutcome: () => true,
        get: (id: string) => ({ routineId, createdAt: startedAt.get(id) }),
      },
      routineNetworkWaits: { forget: vi.fn() },
      workWaiting: { routineRan: vi.fn() },
      routineRunText: text,
      routineRunLast: new Map(),
      // Delivery has its own tests (routine-report-host.test.ts).
      deliversRoutineReports: () => true,
      deliverRunReport: async () => undefined,
      routineHome: () => dir,
      emitEvent: vi.fn(),
      pauseIfQuietRepeatedly: proto.pauseIfQuietRepeatedly,
      pauseRoutine: proto.pauseRoutine,
      pauseIfFailingRepeatedly: vi.fn(),
    };
    return (reply: string) => {
      count += 1;
      const sessionId = `run-${count}`;
      text.set(sessionId, [reply]);
      // Apart, and after any resume made just before.
      startedAt.set(sessionId, new Date(Date.now() + count).toISOString());
      proto.settleRoutineRun.call(service, {
        turnId: sessionId,
        sessionId,
        kind: "reply",
        startedAt: count,
        endedAt: Date.now() + count,
      });
    };
  };

  it("pauses after three quiet runs in a row, and not again once the user resumes it", async () => {
    const { getJob, updateJob } =
      await import("./services/agent-tools/cron-store");
    const job = createJob({ schedule: "0 * * * *", prompt: "check my inbox" });
    const run = runner(job.id, path.join(home, "routine-home"));

    run("Checked the inbox.NO_REPLY");
    run("NO_REPLY");
    // Something found breaks the streak.
    run("Two new mails from your landlord: rent is due Friday.");
    run("NO_REPLY");
    run("Looked again: NO_REPLY");
    expect(getJob(job.id)?.enabled).toBe(true);

    run("NO_REPLY");
    expect(getJob(job.id)?.enabled).toBe(false);
    // The app's pause, apart from the user's own switch.
    expect(getJob(job.id)?.pausedBy).toBe("app");
    expect(getJob(job.id)?.runs[0]).toMatchObject({
      kind: "paused",
      result: "paused after 3 runs in a row found nothing new",
    });

    // Resumed: the user wants it polling, so quiet runs no longer pause it.
    updateJob(job.id, { enabled: true });
    expect(getJob(job.id)?.pausedBy).toBeNull();
    for (let i = 0; i < 4; i++) run("NO_REPLY");
    expect(getJob(job.id)?.enabled).toBe(true);
  });

  it("never pauses a watcher, whose runs mostly find nothing", async () => {
    const { getJob } = await import("./services/agent-tools/cron-store");
    const job = createJob({
      schedule: "0 * * * *",
      prompt: "fix new review comments",
      quietIsNormal: true,
    });
    const run = runner(job.id, path.join(home, "routine-home"));
    for (let i = 0; i < 6; i++) run("NO_REPLY");
    expect(getJob(job.id)?.enabled).toBe(true);
  });
});

describe("a routine that watches a site", () => {
  const proto = ServiceHost.prototype as unknown as {
    startRoutineRun: (id: string, trigger: string) => Promise<string>;
    checkRoutineSite: (id: string, url: string) => Promise<unknown>;
    routineLinkDown: (job: unknown) => boolean;
    routineActsElsewhere: (job: unknown) => boolean;
  };
  const answers: Array<number | "none"> = [];
  let online = true;
  const host = () => ({
    connectivity: {
      ensureFresh: async () => (online ? "online" : "offline"),
    },
    checkRoutineSite: proto.checkRoutineSite,
    messagingGatewayService: { unlinkedPlatforms: () => [] },
    deliversRoutineReports: () => true,
    agentSessionManagerService: { get: () => null },
    routineLinkDown: proto.routineLinkDown,
    routineActsElsewhere: proto.routineActsElsewhere,
    routineAtCreditWall: async () => false,
    routineMissingAccount: async () => null,
    emitEvent: () => undefined,
    listRoutineRuns: () => [],
    // Past every check: the run itself would start here.
    get ensureRoutineWorkspace() {
      throw new Error("ran");
    },
  });
  const fire = (id: string, trigger = "schedule") =>
    proto.startRoutineRun.call(host(), id, trigger).catch(() => "ran");

  beforeEach(() => {
    answers.length = 0;
    online = true;
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ apiKeys: { ABACUS_API_KEY: "x" } })
    );
    vi.stubGlobal("fetch", async () => {
      const next = answers.shift() ?? 200;
      if (next === "none") throw new TypeError("fetch failed");
      return new Response(null, { status: next });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("runs only when the site goes down or comes back, and records nothing between", async () => {
    const { getJob } = await import("./services/agent-tools/cron-store");
    const job = createJob({
      schedule: "*/5 * * * *",
      prompt: "watch my site",
      uptimeUrl: "https://example.com",
    });
    answers.push(200, 502, 502, 503, 200, 404);
    expect(await fire(job.id)).toBe("skipped"); // up
    expect(await fire(job.id)).toBe("skipped"); // one failure is a blip
    expect(await fire(job.id)).toBe("ran"); // down
    expect(getJob(job.id)?.uptime).toMatchObject({ down: true, failures: 2 });
    expect(await fire(job.id)).toBe("skipped"); // still down: said once
    expect(await fire(job.id)).toBe("ran"); // back up
    expect(await fire(job.id)).toBe("skipped"); // a 404 is an answer: up
    expect(getJob(job.id)?.runs).toEqual([]);
  });

  it("counts nothing while this computer is offline", async () => {
    const { getJob } = await import("./services/agent-tools/cron-store");
    const job = createJob({
      schedule: "*/5 * * * *",
      prompt: "watch my site",
      uptimeUrl: "https://example.com",
    });
    online = false;
    answers.push("none", "none", "none");
    for (let i = 0; i < 3; i++) expect(await fire(job.id)).toBe("skipped");
    expect(getJob(job.id)?.uptime ?? null).toBeNull();
    // No answer while the network is up: the site is the one down.
    online = true;
    answers.push("none", "none");
    expect(await fire(job.id)).toBe("skipped");
    expect(await fire(job.id)).toBe("ran");
  });

  it("always runs when asked, with the site as it is", async () => {
    const job = createJob({
      prompt: "watch my site",
      uptimeUrl: "https://example.com",
    });
    expect(await fire(job.id, "create")).toBe("ran");
    expect(await fire(job.id, "manual")).toBe("ran");
    // A cut-off run is made up even though the site has not changed since.
    expect(await fire(job.id, "interrupted")).toBe("ran");
  });
});

describe("what the status board hears about routines (read off the store)", () => {
  const proto = ServiceHost.prototype as unknown as {
    reportRoutineStates: () => void;
    routineDetail: (job: unknown) => unknown;
    clearSignedOutStops: () => void;
  };
  const boardHost = async () => {
    const { StatusBoard } = await import("./services/status/status-board");
    const board = new StatusBoard({
      file: () => null,
      words: async () => ({ t: (key: string) => key }),
    });
    const lanesOff = new Set<string>();
    const host = {
      statusBoard: board,
      prefs: null,
      routineDetail: proto.routineDetail,
      clearSignedOutStops: () => {},
      messagingGatewayService: { laneOff: (id: string) => lanesOff.has(id) },
    };
    return {
      board,
      lanesOff,
      report: () => proto.reportRoutineStates.call(host),
    };
  };

  it("an app pause is paused-by-app with its reason; the user's own pause is not a stop", async () => {
    const { recordRun, updateJob } =
      await import("./services/agent-tools/cron-store");
    const { board, report } = await boardHost();
    const quiet = createJob({ schedule: "0 * * * *", prompt: "watch replies" });
    updateJob(quiet.id, { enabled: false, pausedBy: "app" });
    recordRun(quiet.id, ROUTINE_PAUSE_NOTES.quiet, "schedule", {
      kind: "paused",
    });
    const mine = createJob({ schedule: "0 * * * *", prompt: "my own pause" });
    updateJob(mine.id, { enabled: false });
    report();
    expect(board.get(`routine:${quiet.id}`)).toMatchObject({
      state: "paused-by-app",
      reason: "quiet",
    });
    expect(board.get(`routine:${mine.id}`)).toBeNull();

    // Resumed by the user: the stop is over.
    updateJob(quiet.id, { enabled: true });
    report();
    expect(board.get(`routine:${quiet.id}`)).toBeNull();
  });

  it("a routine that finished what it waited for is not a stop", async () => {
    const { recordRun, updateJob } =
      await import("./services/agent-tools/cron-store");
    const { board, report } = await boardHost();
    const job = createJob({
      schedule: "*/10 * * * *",
      prompt: "check the download",
      until: "the download has finished",
    });
    updateJob(job.id, { enabled: false, pausedBy: "app" });
    recordRun(job.id, ROUTINE_PAUSE_NOTES.done, "schedule", { kind: "paused" });
    report();
    expect(board.get(`routine:${job.id}`)).toBeNull();
  });

  it("a pause an older build made (no pausedBy) is found by its history and told", async () => {
    const { recordRun, writeJobsForTest } =
      await import("./services/agent-tools/cron-store").then((store) => ({
        ...store,
        writeJobsForTest: (id: string) => {
          const job = store.getJob(id)!;
          // As 1.1.11 left it: off, a pause note, and no pausedBy at all.
          store.updateJob(id, { enabled: false });
          const file = path.join(home, "cronjobs.json");
          const jobs = JSON.parse(fs.readFileSync(file, "utf8")) as Array<
            Record<string, unknown>
          >;
          for (const row of jobs) if (row.id === job.id) delete row.pausedBy;
          fs.writeFileSync(file, JSON.stringify(jobs));
        },
      }));
    const { board, report } = await boardHost();
    const job = createJob({ schedule: "0 * * * *", prompt: "hourly watcher" });
    recordRun(job.id, ROUTINE_PAUSE_NOTES.failures, "schedule", {
      kind: "paused",
    });
    writeJobsForTest(job.id);
    report();
    expect(board.get(`routine:${job.id}`)).toMatchObject({
      state: "paused-by-app",
      reason: "failing",
    });
  });

  it("a routine whose chat app is switched off (as an older build left it) is held, until it is back on", async () => {
    const { noteChatPlatform } =
      await import("./services/agent-tools/cron-store");
    const { board, lanesOff, report } = await boardHost();
    const job = createJob({ schedule: "0 * * * *", prompt: "send my digest" });
    noteChatPlatform(job.id, "whatsapp");
    lanesOff.add("whatsapp");
    report();
    expect(board.get(`routine:${job.id}`)).toMatchObject({
      state: "paused-by-app",
      reason: "lane-off",
      detail: { platform: "whatsapp" },
    });
    lanesOff.delete("whatsapp");
    report();
    expect(board.get(`routine:${job.id}`)).toBeNull();
  });
});

describe("when a routine stops firing", () => {
  const proto = ServiceHost.prototype as unknown as {
    settleRoutineRun: (record: unknown) => void;
    pauseIfQuietRepeatedly: (routineId: string) => void;
    pauseRoutine: (routineId: string, reason: string) => void;
  };

  /**
   * The real scheduler and store, each fire settled at once with the next
   * reply in `replies` (a routine run's turn closing). Returns the minutes
   * that fired, per routine.
   */
  const schedulerWith = async (replies: Record<string, string[]>) => {
    const { CronScheduler } =
      await import("./services/agent-tools/cron-scheduler");
    const { getJob } = await import("./services/agent-tools/cron-store");
    const fired: Record<string, number> = {};
    const service = {
      agentSessionManagerService: {
        isRoutineSession: () => true,
        setRunOutcome: () => true,
        get: (id: string) => ({
          routineId: id.split(":")[0],
          createdAt: new Date().toISOString(),
        }),
      },
      routineNetworkWaits: { forget: vi.fn() },
      workWaiting: { routineRan: vi.fn() },
      routineRunText: new Map<string, string[]>(),
      routineRunLast: new Map(),
      // Delivery has its own tests (routine-report-host.test.ts).
      deliversRoutineReports: () => true,
      deliverRunReport: async () => undefined,
      routineHome: (job: { id: string }) => path.join(home, job.id),
      emitEvent: vi.fn(),
      pauseIfQuietRepeatedly: proto.pauseIfQuietRepeatedly,
      pauseRoutine: proto.pauseRoutine,
      pauseIfFailingRepeatedly: vi.fn(),
    };
    const scheduler = new CronScheduler(async (id) => {
      fired[id] = (fired[id] ?? 0) + 1;
      const sessionId = `${id}:${fired[id]}`;
      service.routineRunText.set(sessionId, [
        replies[id]?.[fired[id] - 1] ?? "Checked.",
      ]);
      proto.settleRoutineRun.call(service, {
        turnId: sessionId,
        sessionId,
        kind: "reply",
        startedAt: 0,
        endedAt: Date.now(),
      });
    });
    // Ticks a minute apart from the next whole minute, as the timer would.
    const start = Math.ceil(Date.now() / 60_000) * 60_000;
    const tick = (minute: number) =>
      scheduler.tick(new Date(start + minute * 60_000 + 5_000));
    return { fired, tick, getJob };
  };

  it("a one-time routine fires once and is then done", async () => {
    const job = createJob({
      runAt: Date.now(),
      prompt: "remind me to stretch",
    });
    const { fired, tick, getJob } = await schedulerWith({});

    for (let minute = 0; minute < 5; minute++) await tick(minute);

    expect(fired[job.id]).toBe(1);
    expect(getJob(job.id)?.enabled).toBe(false);
  });

  it("a routine waiting for something recurs until a run finds it, then is retired by the app", async () => {
    const { readLastRoutineRun } =
      await import("./services/agent-tools/routine-runs-store");
    const job = createJob({
      schedule: "* * * * *",
      prompt: "Check the model download and tell me when it is done.",
      until: "the model download has finished",
    });
    // The run is told what it waits for and how to say it happened.
    expect(buildRoutineFirePrompt(job, "schedule", null)).toContain(
      "This routine waits for: the model download has finished."
    );
    const { fired, tick, getJob } = await schedulerWith({
      [job.id]: [
        "Still downloading: 40%.",
        "Still downloading: 85%.",
        "The download finished: the model is ready to load.\nROUTINE_DONE",
      ],
    });

    for (let minute = 0; minute < 10; minute++) await tick(minute);

    expect(fired[job.id]).toBe(3);
    expect(getJob(job.id)?.enabled).toBe(false);
    expect(getJob(job.id)?.runs[0]).toMatchObject({
      kind: "paused",
      result: "finished: what it was waiting for happened",
    });
    // The marker is the app's: the run's record keeps the report without it.
    expect(readLastRoutineRun(path.join(home, job.id))?.reply).toBe(
      "The download finished: the model is ready to load."
    );
  });

  it("a recurring routine with no end condition keeps recurring, whatever a run says", async () => {
    const job = createJob({ schedule: "* * * * *", prompt: "daily brief" });
    const { fired, tick, getJob } = await schedulerWith({
      [job.id]: ["Here is your brief. ROUTINE_DONE", "Here is your brief."],
    });

    for (let minute = 0; minute < 4; minute++) await tick(minute);

    expect(fired[job.id]).toBe(4);
    expect(getJob(job.id)?.enabled).toBe(true);
    expect(buildRoutineFirePrompt(job, "schedule", null)).not.toContain(
      "ROUTINE_DONE"
    );
  });
});

describe("the note a failing routine's pause records", () => {
  const proto = ServiceHost.prototype as unknown as {
    settleRoutineRun: (record: unknown) => void;
    pauseIfFailingRepeatedly: (routineId: string) => void;
    pauseRoutine: (routineId: string, reason: string) => void;
    listRoutineRuns: (routineId: string) => unknown[];
  };

  /** Settles one failed run of the routine with `error`. */
  const failer = (routineId: string, dir: string) => {
    const sessions = new Map<string, { createdAt: string; outcome: string }>();
    const service = {
      agentSessionManagerService: {
        isRoutineSession: () => true,
        setRunOutcome: (id: string, outcome: string) => {
          sessions.get(id)!.outcome = outcome;
          return true;
        },
        get: (id: string) => ({
          routineId,
          createdAt: sessions.get(id)?.createdAt,
        }),
        listByRoutine: () =>
          [...sessions].reverse().map(([id, s]) => ({
            id,
            workspaceId: "ws",
            createdAt: s.createdAt,
            updatedAt: s.createdAt,
            runOutcome: s.outcome,
          })),
      },
      routineNetworkWaits: { forget: vi.fn() },
      workWaiting: { routineRan: vi.fn() },
      routineRunText: new Map<string, string[]>(),
      routineHome: () => dir,
      emitEvent: vi.fn(),
      pauseRoutine: proto.pauseRoutine,
      pauseIfFailingRepeatedly: proto.pauseIfFailingRepeatedly,
      listRoutineRuns: proto.listRoutineRuns,
    };
    return (error: object) => {
      const sessionId = `run-${sessions.size + 1}`;
      sessions.set(sessionId, {
        createdAt: new Date(Date.now() + sessions.size + 1).toISOString(),
        outcome: "running",
      });
      service.routineRunText.set(sessionId, []);
      proto.settleRoutineRun.call(service, {
        turnId: sessionId,
        sessionId,
        kind: "failed",
        error,
        startedAt: 0,
        endedAt: Date.now(),
      });
    };
  };

  it.each([
    [
      "failures",
      { message: "It broke." },
      3,
      "paused after 3 failed runs in a row",
    ],
  ])(
    "%s: keeps the text already on users' disks",
    async (_, error, runs, note) => {
      const { getJob } = await import("./services/agent-tools/cron-store");
      const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
      const fail = failer(job.id, path.join(home, "routine-home"));
      for (let i = 1; i < runs; i++) fail(error);
      expect(getJob(job.id)?.enabled).toBe(true);
      fail(error);
      expect(getJob(job.id)?.enabled).toBe(false);
      expect(getJob(job.id)?.runs[0]).toMatchObject({
        kind: "paused",
        result: note,
      });
    }
  );
});

describe("a scheduled run the app closed under", () => {
  /** Each run's thread as the store keeps it, across launches. */
  const threads = new Map<string, Array<{ role: string; parts: unknown[] }>>();
  const call = (id: string, name: string, input: object) => ({
    type: "tool-call",
    id,
    name: `abacus-connectors_${name}`,
    arguments: JSON.stringify(input),
    state: "complete",
  });
  const answered = (id: string) => ({
    type: "tool-result",
    toolCallId: id,
    content: "ok",
    state: "complete",
  });
  beforeEach(() => {
    threads.clear();
    sessionRecords.clear();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 13, 8, 0) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * One app launch at `at`: the sessions restored, the turn journal's open
   * turns closed into the real settle, and a scheduler whose run opens a
   * stamped session and its turn and sends the briefing once.
   */
  const launch = async (at: Date) => {
    vi.setSystemTime(at);
    const { AgentSessionManagerService } =
      await import("./services/session/agent-session-manager-service");
    const { TurnLedger } = await import("./services/session/turn-ledger");
    const { CronScheduler } =
      await import("./services/agent-tools/cron-scheduler");
    const { getJob, recordRun } =
      await import("./services/agent-tools/cron-store");
    const { buildRoutineFirePrompt } =
      await import("./services/agent-tools/routine-prompt");
    const { readLastRoutineRun } =
      await import("./services/agent-tools/routine-runs-store");
    const { NetworkWaitClock } =
      await import("./services/agent-tools/routine-guards");
    const { RoutineSendLedger } =
      await import("./services/agent-tools/routine-send-ledger");
    const sessions = new AgentSessionManagerService();
    sessions.initialize(["ws"]);
    const turns = new TurnLedger({
      journal: () => path.join(home, "turns-open.json"),
    });
    const sends = new RoutineSendLedger({
      file: () => path.join(home, "routine-sends.json"),
    });
    const service = Object.assign(Object.create(ServiceHost.prototype), {
      agentSessionManagerService: sessions,
      routineSends: sends,
      routineNetworkWaits: new NetworkWaitClock(),
      workWaiting: { routineRan: vi.fn() },
      routineRunText: new Map<string, string[]>(),
      routineHome: () => path.join(home, "routine-home"),
      threadStore: {
        readCurrentFile: (id: string) => ({ messages: threads.get(id) ?? [] }),
      },
      emitEvent: vi.fn(),
      pauseRoutine: vi.fn(),
      pauseIfFailingRepeatedly: vi.fn(),
    }) as {
      settleRoutineRun(record: unknown): void;
      outwardSoFar(
        fire: string,
        sessionId: string | null
      ): { done: string[]; unsure: string[] };
      pauseIfFailingRepeatedly: unknown;
    };
    turns.onClose((record) => service.settleRoutineRun(record));
    turns.recover();
    const fires: Array<{
      trigger: string;
      resent: boolean;
      sent: string[];
      prompt?: string;
    }> = [];
    const cron = new CronScheduler(
      async (jobId, trigger, fire) => {
        const session = sessions.create("ws", jobId, null, trigger);
        recordRun(jobId, `started session ${session.id}`, trigger, {
          id: fire.attemptId,
          kind: "started",
          sessionId: session.id,
        });
        turns.begin(session.id);
        const key = `${jobId}@${fire.slot}`;
        const sent = sends.recipients(key).map((entry) => entry.to);
        // A make-up is told what the cut-off run did, as startRoutineRun tells it.
        const lastRun = readLastRoutineRun(path.join(home, "routine-home"));
        const prompt =
          trigger === "interrupted"
            ? buildRoutineFirePrompt(getJob(jobId)!, "interrupted", null, {
                dir: "/r",
                workingDirectory: "/r",
                notes: { path: "/r/notes.md", kept: false, maybeAt: null },
                runs: 1,
                lastRun,
                workspaces: [],
                sent: service.outwardSoFar(
                  key,
                  lastRun?.outcome === "interrupted" ? lastRun.sessionId : null
                ),
              })
            : undefined;
        // The run reads mail, mails the brief, and starts a Slack post the
        // app closes under.
        threads.set(session.id, [
          {
            role: "assistant",
            parts: [
              { type: "text", content: "Good morning." },
              call("c1", "Gmail_Tool", { action: "search_email", query: "x" }),
              answered("c1"),
              call("c2", "Gmail_Tool", {
                action: "send_email",
                to: "bob@example.com",
                subject: "Brief",
              }),
              answered("c2"),
              call("c3", "Slack_Tool", {
                action: "send_message",
                channel: "#team",
              }),
            ],
          },
        ]);
        const repeat = sends.repeat(
          key,
          "whatsapp",
          "Ana",
          session.id,
          "Brief"
        );
        if (repeat == null)
          sends.record(key, "whatsapp", "Ana", session.id, "Brief");
        fires.push({
          trigger,
          resent: repeat == null && sent.length > 0,
          sent,
          ...(prompt != null ? { prompt } : {}),
        });
      },
      async () => true,
      () => {},
      async () => {}
    );
    const tick = async (when: Date) => {
      vi.setSystemTime(when);
      await cron.tick(when);
    };
    /** Run now, as the user's button does: no scheduled moment claimed. */
    const runNow = (jobId: string) => {
      const session = sessions.create("ws", jobId, null, "manual");
      recordRun(jobId, `started session ${session.id}`, "manual", {
        kind: "started",
        sessionId: session.id,
      });
      turns.begin(session.id);
    };
    /** Each run's outcome, as the routine's run list shows it. */
    const outcomes = (jobId: string) =>
      sessions.listByRoutine(jobId).map((session) => session.runOutcome);
    return { service, fires, tick, runNow, outcomes };
  };

  it("is made up once, sends nothing twice, is not a failure, and is not made up again", async () => {
    const { readLastRoutineRun } =
      await import("./services/agent-tools/routine-runs-store");
    const job = createJob({ schedule: "0 9 * * *", prompt: "Brief me" });
    const first = await launch(new Date(2026, 9, 13, 8, 59));
    await first.tick(new Date(2026, 9, 13, 9, 0, 5));
    expect(first.fires).toEqual([
      { trigger: "schedule", resent: false, sent: [] },
    ]);

    // Quit mid-run; relaunched at 9:20.
    const second = await launch(new Date(2026, 9, 13, 9, 20));
    expect(readLastRoutineRun(path.join(home, "routine-home"))).toMatchObject({
      outcome: "interrupted",
      reply: "Good morning.",
    });
    await second.tick(new Date(2026, 9, 13, 9, 20));
    await second.tick(new Date(2026, 9, 13, 9, 21));
    expect(second.fires).toMatchObject([
      { trigger: "interrupted", resent: false, sent: ["Ana"] },
    ]);
    // The connector actions it did are named, its read is not, and the post
    // it never heard back from is flagged as maybe sent.
    const told = second.fires[0]!.prompt!;
    expect(told).toContain(
      "already done: whatsapp message to Ana; Gmail_Tool send_email (to: bob@example.com; subject: Brief). Do not do any of these again"
    );
    expect(told).not.toContain("search_email");
    expect(told).toContain(
      "no answer before the app closed: Slack_Tool send_message (channel: #team). It may have gone through"
    );
    expect(second.service.pauseIfFailingRepeatedly).not.toHaveBeenCalled();

    // The make-up is cut off too: nothing more is made up for 9:00.
    const third = await launch(new Date(2026, 9, 13, 9, 40));
    await third.tick(new Date(2026, 9, 13, 9, 40));
    await third.tick(new Date(2026, 9, 13, 10, 0));
    expect(third.fires).toEqual([]);
    expect(third.outcomes(job.id)).toEqual(["interrupted", "interrupted"]);
    expect(listJobs()[0]).toMatchObject({ enabled: true, heldSince: null });
  });

  it("is a scheduled one: a Run now the app closed under is not made up", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "Brief me" });
    const first = await launch(new Date(2026, 9, 13, 11, 0));
    first.runNow(job.id);

    const next = await launch(new Date(2026, 9, 13, 11, 5));
    await next.tick(new Date(2026, 9, 13, 11, 5));
    expect(next.fires).toEqual([]);
    expect(next.outcomes(job.id)).toEqual(["interrupted"]);
  });

  it("is not made up on a launch close to the next morning's run", async () => {
    createJob({ schedule: "0 9 * * *", prompt: "Brief me" });
    const first = await launch(new Date(2026, 9, 13, 8, 59));
    await first.tick(new Date(2026, 9, 13, 9, 0, 5));

    const next = await launch(new Date(2026, 9, 14, 8, 45));
    await next.tick(new Date(2026, 9, 14, 8, 45));
    expect(next.fires).toEqual([]);
    // The next morning's own run still fires.
    await next.tick(new Date(2026, 9, 14, 9, 0));
    expect(next.fires).toEqual([
      { trigger: "schedule", resent: false, sent: [] },
    ]);
  });
});

describe("a routine whose chat app lost its link", () => {
  const proto = ServiceHost.prototype as unknown as {
    startRoutineRun: (id: string, trigger: string) => Promise<string>;
    routineLinkDown: (job: unknown) => boolean;
    routineActsElsewhere: (job: unknown) => boolean;
    markRoutineLinkLost: (job: unknown) => void;
    routineLinkBack: (platform: string) => void;
  };
  const withLink = (
    unlinked: string[],
    threads: Record<string, { messages: unknown[] }> = {}
  ) => {
    const service = {
      messagingGatewayService: { unlinkedPlatforms: () => unlinked },
      // The desktop app: a routine with a chat of its own still reports there.
      deliversRoutineReports: () => true,
      agentSessionManagerService: { get: () => null },
      routineLinkDown: proto.routineLinkDown,
      markRoutineLinkLost: proto.markRoutineLinkLost,
      routineAtCreditWall: async () => false,
      routineMissingAccount: async () => null,
      routineActsElsewhere: proto.routineActsElsewhere,
      threadStore: { readCurrentFile: (id: string) => threads[id] },
      emitEvent: () => undefined,
      listRoutineRuns: () =>
        Object.keys(threads).map((sessionId) => ({ sessionId })),
      startedAnyway: 0,
      get ensureRoutineWorkspace() {
        service.startedAnyway += 1;
        throw new Error("got past the link check");
      },
    };
    return { service };
  };
  // Signed in: a run is stopped earlier otherwise.
  beforeEach(() => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ apiKeys: { ABACUS_API_KEY: "x" } })
    );
  });
  const fire = (service: unknown, id: string, trigger: string) =>
    proto.startRoutineRun.call(service, id, trigger).catch(() => "ran");

  it.each([
    ["every app it uses is unlinked", ["whatsapp"], ["whatsapp"], "skipped"],
    [
      "one of its apps still works",
      ["whatsapp", "telegram"],
      ["whatsapp"],
      "ran",
    ],
    ["it never sent through a chat app", [], ["whatsapp"], "ran"],
    ["another app is the unlinked one", ["telegram"], ["whatsapp"], "ran"],
    ["the link is only reconnecting", ["whatsapp"], [], "ran"],
  ])("%s", async (_name, used, unlinked, expected) => {
    const { noteChatPlatform } =
      await import("./services/agent-tools/cron-store");
    const job = createJob({ schedule: "0 * * * *", prompt: "tell me" });
    for (const platform of used) noteChatPlatform(job.id, platform);

    expect(await fire(withLink(unlinked).service, job.id, "schedule")).toBe(
      expected
    );
  });

  it("still runs for a bot, whose report reaches the bot's chat in the app", async () => {
    const { noteChatPlatform } =
      await import("./services/agent-tools/cron-store");
    const bot = createBot({ name: "Scout", description: "Watches the rain" });
    const job = createJob({
      schedule: "0 * * * *",
      prompt: "tell me",
      botId: bot.id,
    });
    noteChatPlatform(job.id, "whatsapp");
    expect(await fire(withLink(["whatsapp"]).service, job.id, "schedule")).toBe(
      "ran"
    );
  });

  it("still runs when a recent run also reached someone another way", async () => {
    const { noteChatPlatform } =
      await import("./services/agent-tools/cron-store");
    const job = createJob({
      schedule: "0 * * * *",
      prompt: "mail and ping me",
    });
    noteChatPlatform(job.id, "whatsapp");
    const mail = (action: string) => ({
      messages: [
        {
          parts: [
            {
              type: "tool-call",
              id: "c1",
              name: "abacus-connectors_Gmail_Tool",
              arguments: JSON.stringify({ action }),
            },
            {
              type: "tool-result",
              toolCallId: "c1",
              state: "complete",
            },
          ],
        },
      ],
    });
    const fired = (thread: { messages: unknown[] }) =>
      fire(withLink(["whatsapp"], { run: thread }).service, job.id, "schedule");

    expect(await fired(mail("search_email"))).toBe("skipped");
    expect(await fired(mail("send_email"))).toBe("ran");
  });

  it("is marked at the first skip, and a person pressing Run still gets a run", async () => {
    const { getJob, noteChatPlatform } =
      await import("./services/agent-tools/cron-store");
    const job = createJob({
      schedule: "0 * * * *",
      prompt: "tell me",
      name: "Rain",
    });
    noteChatPlatform(job.id, "whatsapp");
    const { service } = withLink(["whatsapp"]);

    await fire(service, job.id, "schedule");
    const markedAt = getJob(job.id)?.chatLinkLostAt;
    await fire(service, job.id, "schedule");

    expect(markedAt).toEqual(expect.any(Number));
    expect(getJob(job.id)?.chatLinkLostAt).toBe(markedAt);
    expect(getJob(job.id)?.runs[0]?.kind).toBe("skipped-link");
    expect(await fire(service, job.id, "manual")).toBe("ran");
  });

  it("makes up one run when the link is back", async () => {
    const { getJob, noteChatPlatform, setChatLinkLost } =
      await import("./services/agent-tools/cron-store");
    const job = createJob({ schedule: "0 * * * *", prompt: "tell me" });
    const other = createJob({ schedule: "0 * * * *", prompt: "not this" });
    noteChatPlatform(job.id, "whatsapp");
    noteChatPlatform(other.id, "whatsapp");
    setChatLinkLost(job.id, Date.now());

    proto.routineLinkBack.call({}, "whatsapp");

    expect(getJob(job.id)).toMatchObject({
      chatLinkLostAt: null,
      heldFor: "catch-up",
    });
    expect(getJob(other.id)?.heldSince ?? null).toBeNull();
  });

  it("forgets where it sends when its instructions change", async () => {
    const { getJob, noteChatPlatform, updateJob } =
      await import("./services/agent-tools/cron-store");
    const job = createJob({ schedule: "0 * * * *", prompt: "tell me" });
    noteChatPlatform(job.id, "whatsapp");

    updateJob(job.id, { prompt: "write it to a file" });

    expect(getJob(job.id)?.chatPlatforms).toEqual([]);
  });
});

describe("a routine's records when its folder changes", () => {
  const proto = ServiceHost.prototype as unknown as {
    updateLocalRoutine: (id: string, changes: unknown) => unknown;
    routineHome: (job: unknown) => string;
    routineProject: (job: unknown) => unknown;
    realProject: (id: string | null) => unknown;
    strayRoutineHome: (job: unknown) => string | null;
  };
  const service = (workspaces: unknown[]) => ({
    workspaceService: { getWorkspaces: () => workspaces },
    routineHome: proto.routineHome,
    routineProject: proto.routineProject,
    realProject: proto.realProject,
    emitEvent: () => undefined,
  });
  const live = (id: string, dir: string) => ({
    id,
    path: dir,
    status: "active",
  });

  it("go with it to a new project", () => {
    const project = path.join(home, "digest");
    const job = createJob({ schedule: "0 9 * * *", prompt: "digest" });
    const own = path.join(home, "routines", job.id);
    fs.mkdirSync(path.join(own, "runs"), { recursive: true });
    fs.writeFileSync(path.join(own, "runs", "one.md"), "first");

    proto.updateLocalRoutine.call(service([live("p", project)]), job.id, {
      workspaceId: "p",
    });

    expect(
      fs.readdirSync(
        path.join(project, ".abacusai-bot", "routines", job.id, "runs")
      )
    ).toEqual(["one.md"]);
  });

  it.each([
    ["a live project", "active", undefined, false],
    ["a removed project", "deleted", undefined, true],
    ["one of the app's own folders", "active", "routine", true],
  ])("are looked for in %s", (_name, status, kind, stray) => {
    const job = { id: "job-1", workspaceId: "w" };
    const found = proto.strayRoutineHome.call(
      service([{ id: "w", path: "/somewhere", status, kind }]),
      job
    );
    expect(found != null).toBe(stray);
  });
});

describe("a routine fired while signed out", () => {
  it("records the run as skipped", async () => {
    const job = createJob({ prompt: "p", schedule: "0 9 * * *" });
    const startRoutineRun = (
      ServiceHost.prototype as unknown as {
        startRoutineRun(
          id: string,
          trigger: string,
          payload: null
        ): Promise<string>;
      }
    ).startRoutineRun;
    const { StatusBoard } = await import("./services/status/status-board");
    const statusBoard = new StatusBoard({
      file: () => null,
      words: async () => ({ t: (key: string) => key }),
    });
    const host = {
      emitEvent: vi.fn(),
      statusBoard,
      routineDetail: (
        ServiceHost.prototype as unknown as { routineDetail: unknown }
      ).routineDetail,
    };
    await expect(
      startRoutineRun.call(host, job.id, "schedule", null)
    ).resolves.toBe("skipped");
    expect(listJobs()[0]?.runs[0]).toMatchObject({
      result: "skipped: signed out",
      kind: "skipped",
    });
    // Not silent: the board holds it as waiting on the user.
    expect(statusBoard.get(`routine:${job.id}`)).toMatchObject({
      state: "stopped-needs-user",
      reason: "signed-out",
    });
  });
});

describe("the model a session with none of its own starts on", () => {
  const row = (id: string, configured: boolean, recommended = false) => ({
    id,
    label: id,
    provider: id.split("/")[0],
    tier: "default",
    configured,
    ...(recommended ? { recommended: true } : {}),
  });
  beforeEach(() => {
    // A free account: the tier recommends the free pool.
    catalog.reads = 0;
    catalog.rows = [
      row("openllm/auto", true, true),
      row("custom/flash", true),
      row("custom/bot-model", true),
      row("removed/model", false),
    ];
  });
  const start = async (
    session: { routineId: string | null; model: string | null },
    model?: string
  ) => {
    const updates: string[] = [];
    const ready = vi.fn(async () => ({ success: true, created: true }));
    const host = Object.assign(Object.create(ServiceHost.prototype), {
      isWorkspaceDeleted: () => false,
      agentSessionManagerService: {
        get: () => session,
        updateModel: (_id: string, next: string) => {
          session.model = next;
          updates.push(next);
          return true;
        },
      },
      botService: { botIdForSession: () => null },
      agentManagerService: {
        startSessionReady: ready,
        // No agent runs yet: nothing to wait out before the start.
        getSessionState: () => ({ status: "stopped" }),
      },
      emitEvent: vi.fn(),
    }) as InstanceType<typeof ServiceHost>;
    await host.startAgentSession({
      workspaceId: "w",
      sessionId: "run-1",
      ...(model != null ? { model } : {}),
    });
    const [request] = ready.mock.calls[0] as unknown as [{ model?: string }];
    return { model: request.model, updates };
  };

  it("a routine with no bot runs on the stored custom-provider default, not the free pool, and keeps it", async () => {
    setDefaultModel("custom/flash");
    const job = createJob({ prompt: "p", schedule: "0 9 * * *" });
    const run = await start({ routineId: job.id, model: null });
    expect(run.model).toBe("custom/flash");
    expect(run.updates).toEqual(["custom/flash"]);
  });

  it("a routine with a bot runs on the bot's model", async () => {
    setDefaultModel("custom/flash");
    const bot = createBot({
      name: "Digest",
      description: "Sends the digest",
      model: "custom/bot-model",
    });
    const job = createJob({
      prompt: "p",
      schedule: "0 9 * * *",
      botId: bot.id,
    });
    const run = await start({ routineId: job.id, model: null });
    expect(run.model).toBe("custom/bot-model");
    expect(run.updates).toEqual(["custom/bot-model"]);
  });

  it("a chat starts on the composer's model, unresolved and unwritten", async () => {
    setDefaultModel("custom/flash");
    const run = await start({ routineId: null, model: null }, "chosen/model");
    expect(run.model).toBe("chosen/model");
    expect(run.updates).toEqual([]);
    expect(catalog.reads).toBe(0);
  });

  it("an unconfigured stored default falls back to the tier's recommendation", async () => {
    setDefaultModel("removed/model");
    const job = createJob({ prompt: "p", schedule: "0 9 * * *" });
    const run = await start({ routineId: job.id, model: null });
    expect(run.model).toBe("openllm/auto");
  });
});

describe("a routine's own model", () => {
  const proto = ServiceHost.prototype as unknown as {
    resolveUnpinnedModel: (request: {
      workspaceId: string;
      sessionId: string;
    }) => Promise<string | null>;
    moveModelPinsToTier: () => void;
    botOfSession: (sessionId: string) => string | null;
  };
  /** The model a fresh run of `routineId` starts on. */
  const runModel = async (routineId: string): Promise<string | null> => {
    const pins: string[] = [];
    await proto.resolveUnpinnedModel.call(
      {
        agentSessionManagerService: { get: () => ({ routineId }) },
        botService: { botIdForSession: () => null },
        botOfSession: proto.botOfSession,
        setAgentSessionModel: (_w: string, _s: string, model: string) =>
          pins.push(model),
      },
      { workspaceId: "w", sessionId: "run" }
    );
    return pins[0] ?? null;
  };
  const row = (id: string) => ({ id, configured: true, tier: "default" });
  const local = () => host(false, "electron");
  const scout = { name: "Scout", description: "Watches the news." };
  beforeEach(() => {
    catalog.rows = [row("a/kept"), row("b/picked"), row("c/bot")];
  });

  it("a chat's pick reaching the default leaves routines where they are", async () => {
    tier.current = "pro";
    catalog.rows = [
      row("a/kept"),
      row("b/picked"),
      { ...row("r/plan"), recommended: true },
    ];
    const own = createJob({ ...input, model: "a/kept" });
    const plans = await local().createRoutine(input);
    setDefaultModel("b/picked");
    expect(await runModel(own.id)).toBe("a/kept");
    expect(await runModel(plans.id)).toBe("r/plan");
  });

  it.each([
    ["the creating chat's model", { chatModel: "b/picked" }, null, "b/picked"],
    [
      "its bot's model, over the chat's",
      { chatModel: "b/picked" },
      "c/bot",
      "c/bot",
    ],
    ["no model, whatever the stored default,", {}, null, null],
  ])("a new routine stores %s", async (_, options, botModel, stored) => {
    setDefaultModel("a/kept");
    const botId =
      botModel == null ? null : createBot({ ...scout, model: botModel }).id;
    const created = await local().createRoutine(
      { ...input, botId },
      undefined,
      options
    );
    expect(listJobs().find((job) => job.id === created.id)?.model).toBe(stored);
  });

  it("a bot's later model change leaves its routine on the stored one", async () => {
    const { updateBot } = await import("./services/bots/bot-store");
    const bot = createBot({ ...scout, model: "c/bot" });
    const created = await local().createRoutine({ ...input, botId: bot.id });
    updateBot(bot.id, { model: "b/picked" });
    expect(await runModel(created.id)).toBe("c/bot");
  });

  it("a change to a routine's model is what its runs use, read back from disk", async () => {
    const created = await local().createRoutine(input);
    updateJob(created.id, { model: "b/picked" });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, "cronjobs.json"), "utf8")
    ) as Array<{ id: string; model: string }>;
    expect(onDisk.find((job) => job.id === created.id)?.model).toBe("b/picked");
    expect(await runModel(created.id)).toBe("b/picked");
  });

  it("a routine with no model of its own needs a plan to skip the stored default, and an old one keeps its bot", async () => {
    const created = createJob({ ...input, model: null });
    const bot = createBot({ ...scout, model: "c/bot" });
    const old = createJob({ ...input, botId: bot.id });
    setDefaultModel("a/kept");
    expect(await runModel(created.id)).toBe("a/kept");
    expect(await runModel(old.id)).toBe("c/bot");
    tier.current = "pro";
    catalog.rows = [row("a/kept"), { ...row("r/plan"), recommended: true }];
    expect(await runModel(created.id)).toBe("r/plan");
  });

  it("a chat on the plan's default makes a routine that moves with the plan", () => {
    const sources = {
      readDefault: () => null,
      listCatalog: async () => [],
      cachedRecommended: () => "r/plan",
    };
    expect(newRoutineModel(null, "r/plan", sources)).toBeNull();
    expect(newRoutineModel(null, "b/picked", sources)).toBe("b/picked");
    expect(newRoutineModel("r/plan", "b/picked", sources)).toBe("r/plan");
  });

  it("a plan change moves a routine off OpenLLM and leaves other models", async () => {
    tier.current = "pro";
    const free = createJob({ ...input, model: "openllm/auto" });
    const pinned = createJob({ ...input, model: "a/kept" });
    const following = createJob({ ...input, model: null });
    const emitEvent = vi.fn();
    proto.moveModelPinsToTier.call({
      agentSessionManagerService: { listAll: () => [] },
      emitEvent,
    });
    const model = (id: string) =>
      listJobs().find((job) => job.id === id)?.model;
    expect(model(free.id)).toBe("abacus/route-llm-code");
    expect(model(pinned.id)).toBe("a/kept");
    expect(model(following.id)).toBeNull();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cronjobs-updated" })
    );
  });

  it("a costly model is said when the agent makes the routine", async () => {
    catalog.rows = [{ ...row("a/kept"), label: "Pricey", tier: "strong" }];
    const service = local();
    const server = new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["cronjob"]),
      workspacePath: () => null,
      workspaceId: () => null,
      botIdForSession: () => null,
      sessionRole: () => null,
      models: async () => catalog.rows,
      routines: {
        defaultRunner: () => "local",
        hostedOnly: () => false,
        create: (request, options) =>
          service.createRoutine(request, undefined, {
            chatModel: "a/kept",
            ...options,
          }),
        hosted: service.hostedRoutines,
      },
    } as never);
    const result = (await server.executeTool(
      "cronjob",
      { action: "create", ...input, firstRun: false },
      "session-test"
    )) as { content: Array<{ text?: string }> };
    const note = result.content.map((part) => part.text).join("\n");
    expect(note).toContain("Every run uses Pricey");
    expect(note).toContain("model: a/kept");
  });
});

describe("a routine run the machine slept through", () => {
  const proto = ServiceHost.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const sleeper = async (runStartedAt: number, asleepMs: number) => {
    const { ConnectivityService } =
      await import("./services/connectivity/connectivity-service");
    const { StatusBoard } = await import("./services/status/status-board");
    // The sleep ended just now: it began `asleepMs` ago.
    let now = Date.now() - asleepMs;
    const connectivity = new ConnectivityService({
      probe: async () => true,
      now: () => now,
      log: () => {},
    });
    connectivity.suspended();
    now = Date.now();
    connectivity.resumed();
    const job = createJob({ schedule: "0 9 * * *", prompt: "digest" });
    const ended: Array<[string, string, string | undefined]> = [];
    const statusBoard = new StatusBoard({
      file: () => null,
      words: async () => ({ t: (key: string) => key }),
    });
    const host: Record<string, unknown> = {
      connectivity,
      statusBoard,
      frozenRunWatches: new Map(),
      cronScheduler: { tick: async () => {} },
      listRoutineRuns: () => [
        {
          sessionId: "run-1",
          outcome: "running",
          startedAt: new Date(runStartedAt).toISOString(),
        },
      ],
      turnLedger: {
        isOpen: () => true,
        end: (id: string, kind: string, cause?: string) =>
          ended.push([id, kind, cause]),
      },
      agentManagerService: { getRuntimeInfo: () => null },
      stopAgentTurn: vi.fn(),
      routineDetail: proto.routineDetail,
    };
    host.watchFrozenRun = proto.watchFrozenRun!.bind(host);
    return { host, job, ended, statusBoard, now: () => now };
  };

  it("is given awake time to show progress, then made up as interrupted, not timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host, job, ended, statusBoard } = await sleeper(
        Date.now() - 50 * 60_000,
        45 * 60_000
      );
      proto.routinesAfterWake!.call(host);
      expect((host.frozenRunWatches as Map<string, unknown>).size).toBe(1);
      vi.advanceTimersByTime(119_000);
      expect(ended).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(ended).toEqual([
        ["run-1", "app_closed", "no progress after wake"],
      ]);
      // No make-up was held here (the ledger is a stub), so none is claimed.
      expect(statusBoard.get(`routine:${job.id}`)).toMatchObject({
        state: "missed",
        detail: { madeUp: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not watched when the sleep did not overlap it, or was short", async () => {
    // Started after the sleep ended: it slept through nothing.
    const run = await sleeper(Date.now() - 1000, 45 * 60_000);
    proto.routinesAfterWake!.call(run.host);
    expect((run.host.frozenRunWatches as Map<string, unknown>).size).toBe(0);
    const short = await sleeper(Date.now() - 5 * 60_000, 60_000);
    proto.routinesAfterWake!.call(short.host);
    expect((short.host.frozenRunWatches as Map<string, unknown>).size).toBe(0);
  });
});

describe("keep-awake's routine-due signal", () => {
  const proto = ServiceHost.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const host = () => {
    const seen: boolean[] = [];
    const self: Record<string, unknown> = {
      routineDueNow: false,
      routineDueListeners: new Set([(due: boolean) => seen.push(due)]),
      routineRunText: new Map(),
      turnLedger: { isOpen: () => false },
    };
    return { self, seen };
  };
  const at = (minutes: number) => {
    const d = new Date(Date.now() + minutes * 60_000);
    return `${d.getMinutes()} ${d.getHours()} * * *`;
  };

  it("is due just before a sparse routine's slot, not for one every few minutes", () => {
    const { self, seen } = host();
    createJob({ schedule: "*/5 * * * *", prompt: "frequent" });
    proto.noteRoutineDue!.call(self);
    expect(seen).toEqual([]);
    createJob({ schedule: at(1), prompt: "daily, a minute away" });
    proto.noteRoutineDue!.call(self);
    expect(seen).toEqual([true]);
  });

  it("stays due while a routine run's turn is open, read from memory", () => {
    const { self, seen } = host();
    self.routineRunText = new Map([["run-1", []]]);
    self.turnLedger = { isOpen: (id: string) => id === "run-1" };
    proto.noteRoutineDue!.call(self);
    expect(seen).toEqual([true]);
  });
});
