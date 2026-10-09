import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./rpc/testing";
import { listJobs } from "./services/agent-tools/cron-store";
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
const { ServiceHost } = await import("./service-host");
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
const host = (hostedOnly = false) =>
  Object.assign(
    { createRoutine: ServiceHost.prototype.createRoutine },
    {
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
      expect(result.content.map((part) => part.text).join("\n")).toContain(
        "plan"
      );
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
