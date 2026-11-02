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
