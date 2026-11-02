import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./rpc/testing";
import { createJob, listJobs } from "./services/agent-tools/cron-store";
import { HostedRoutineRefusal } from "./services/agent-tools/hosted-routines";
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
vi.mock("./services/providers/abacus", async (original) => ({
  ...(await original<typeof import("./services/providers/abacus")>()),
  fetchAbacusAccount: account,
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
let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "routine-plan-"));
  process.env.ABACUSAI_BOT_HOME = home;
  account.mockReset();
  account.mockResolvedValue({ subscription_tier: "free", plan: null });
});
afterEach(() => {
  vi.restoreAllMocks();
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
    await expect(
      startRoutineRun.call({ emitEvent: vi.fn() }, job.id, "schedule", null)
    ).resolves.toBe("skipped");
    expect(listJobs()[0]?.runs[0]).toMatchObject({
      result: "skipped: signed out",
      kind: "skipped",
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
      agentManagerService: { startSessionReady: ready },
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
