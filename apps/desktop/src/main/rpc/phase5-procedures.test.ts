/**
 * Spec 05 §31.5's new procedures through the real router and transport:
 * `window.setDensity` (b), `system.loginItem` (c) with its typed Linux
 * refusal, typed routine errors (e), `routines.events` (j).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TimeoutError } from "@abacus-ai/contract/timeout-error";
import { afterEach, describe, expect, it, vi, onTestFinished } from "vitest";

import {
  createJob,
  updateJob,
  onRoutineRunStarted,
  recordRun,
} from "../services/agent-tools/cron-store";
import { HostedRoutineRefusal } from "../services/agent-tools/hosted-routines";
import { createLoginItem } from "../services/config/login-item";
import { connectInProcess, fakeDeps, type FakeDepsOverrides } from "./testing";

const connections: Array<{ closeClient(): void; closeServer(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const connect = (overrides: FakeDepsOverrides) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const connection = connectInProcess(fakeDeps(overrides));
  connections.push(connection);
  return connection.client;
};

describe("window.setDensity (spec 05 §31.5 b)", () => {
  it("runs the legacy handler's body and answers its result", async () => {
    const setTitlebarDensity = vi.fn(async (density: unknown) => ({
      density: density as "compact",
      appliesOnRestart: false,
    }));
    const client = connect({ app: { setTitlebarDensity } });
    await expect(
      client.window.setDensity({ density: "compact" })
    ).resolves.toEqual({ density: "compact", appliesOnRestart: false });
    expect(setTitlebarDensity).toHaveBeenCalledWith("compact");
  });

  it("refuses a density the schema does not know", async () => {
    const setTitlebarDensity = vi.fn();
    const client = connect({ app: { setTitlebarDensity } });
    await expect(
      client.window.setDensity({ density: "tiny" as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(setTitlebarDensity).not.toHaveBeenCalled();
  });
});

describe("system.loginItem (spec 05 §31.5 c)", () => {
  const electronApp = () => {
    let openAtLogin = false;
    return {
      getLoginItemSettings: () => ({ openAtLogin }),
      setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
        openAtLogin = settings.openAtLogin;
      },
    };
  };

  it("reads and writes on macOS", async () => {
    const client = connect({
      app: { loginItem: createLoginItem(electronApp(), "darwin") },
    });
    await expect(client.system.loginItem.get()).resolves.toEqual({
      openAtLogin: false,
    });
    await expect(
      client.system.loginItem.set({ openAtLogin: true })
    ).resolves.toEqual({ openAtLogin: true });
    await expect(client.system.loginItem.get()).resolves.toEqual({
      openAtLogin: true,
    });
  });

  it("is PRECONDITION_FAILED unsupported-platform on Linux", async () => {
    const client = connect({
      app: { loginItem: createLoginItem(electronApp(), "linux") },
    });
    for (const call of [
      () => client.system.loginItem.get(),
      () => client.system.loginItem.set({ openAtLogin: true }),
    ])
      await expect(call()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        defined: true,
        data: { reason: "unsupported-platform" },
      });
  });
});

describe("typed routine errors (spec 05 §31.5 e)", () => {
  it("the free plan's second hosted routine is PRECONDITION_FAILED plan-required", async () => {
    const client = connect({
      serviceHost: {
        createRoutine: async () => {
          throw new HostedRoutineRefusal("plan_limit", {
            upgrade: { url: "https://x.example" },
          });
        },
      },
    });
    await expect(
      client.db.routines.insert({
        prompt: "p",
        schedule: "0 9 * * *",
        runner: "hosted",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      defined: true,
      data: { reason: "plan-required" },
    });
  });

  it("a paid plan's cap is PRECONDITION_FAILED routine-limit", async () => {
    const client = connect({
      serviceHost: {
        createRoutine: async () => {
          throw new HostedRoutineRefusal("limit", { limit: 5, plan: "paid" });
        },
      },
    });
    await expect(
      client.db.routines.insert({
        prompt: "p",
        schedule: "0 9 * * *",
        runner: "hosted",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "routine-limit" },
    });
  });

  it.each([
    [{ kind: "watch" }, "plan-kind"],
    [{ min_interval_secs: 86_400 }, "plan-interval"],
    [{ limit: 1 }, "plan-required"],
  ])(
    "the free plan's limit by its cause (%j) is PRECONDITION_FAILED %s",
    async (facts, reason) => {
      const client = connect({
        serviceHost: {
          createRoutine: async () => {
            throw new HostedRoutineRefusal("plan_limit", {
              ...facts,
              upgrade: { url: "https://x.example/up" },
            });
          },
        },
      });
      await expect(
        client.db.routines.insert({
          prompt: "p",
          schedule: "*/5 * * * *",
          runner: "hosted",
        })
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        data: { reason, detail: "https://x.example/up" },
      });
    }
  );

  it.each([
    ["no_host", "no-host"],
    ["routine_not_active", "routine-not-active"],
    ["busy", "routine-busy"],
    ["queue_full", "queue-full"],
    ["wrong_bot", "wrong-bot"],
    ["not_available", "routines-off"],
  ])(
    "a hosted %s on a change or resume is PRECONDITION_FAILED %s",
    async (code, reason) => {
      const client = connect({
        serviceHost: {
          updateRoutine: async () => {
            throw new HostedRoutineRefusal(code, {});
          },
        },
      });
      await expect(
        client.db.routines.update({
          id: "hosted-r1",
          patch: { enabled: true },
        })
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        data: { reason },
      });
    }
  );

  it.each([
    ["invalid_source_url", "sources", "sources"],
    ["invalid_connector_reads", "reads", "reads"],
    ["interval_too_short", "interval", "schedule"],
    ["invalid_timezone", "timezone", "schedule"],
    ["invalid_schedule", "schedule", "schedule"],
  ])(
    "a hosted %s is BAD_REQUEST with the refused value",
    async (code, refusal, field) => {
      const client = connect({
        serviceHost: {
          createRoutine: async () => {
            throw new HostedRoutineRefusal(code, { secret: "x" });
          },
        },
      });
      const refused = await client.db.routines
        .insert({ prompt: "p", schedule: "0 9 * * *", runner: "hosted" })
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({
        code: "BAD_REQUEST",
        defined: true,
        data: { refusal, field },
      });
      expect(JSON.stringify(refused)).not.toContain("secret");
    }
  );

  it("an unknown hosted refusal is UNAVAILABLE, with nothing of the server's", async () => {
    const client = connect({
      serviceHost: {
        createRoutine: async () => {
          throw new HostedRoutineRefusal("internal_error", { secret: "x" });
        },
      },
    });
    const refused = await client.db.routines
      .insert({ prompt: "p", schedule: "0 9 * * *", runner: "hosted" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "UNAVAILABLE", defined: true });
    expect(JSON.stringify(refused)).not.toContain("secret");
  });

  it("a schedule that does not parse is BAD_REQUEST { field, detail }", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cron-parse-rpc-"));
    const previousHome = process.env.ABACUSAI_BOT_HOME;
    process.env.ABACUSAI_BOT_HOME = home;
    const job = createJob({ prompt: "p" }, "job-1");
    expect(job.id).toBe("job-1");
    const client = connect({
      serviceHost: { createRoutine: createJob, updateRoutine: updateJob },
    });
    // Restore after both RPC calls, even if an assertion fails.
    onTestFinished(() => {
      if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
      else process.env.ABACUSAI_BOT_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    });
    const detail =
      "Names like MON or JAN are not supported. Use numbers: 0-6 for weekday, 1-12 for month.";
    await expect(
      client.db.routines.insert({ prompt: "p", schedule: "0 9 * * MON" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      defined: true,
      data: { field: "schedule", detail },
    });
    await expect(
      client.db.routines.update({
        id: "job-1",
        patch: { schedule: "0 9 * *" },
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: {
        field: "schedule",
        detail: "Expected five fields (minute hour day month weekday), got 4.",
      },
    });
  });

  it("an edit-by-chat that never answers is TIMEOUT { ms }", async () => {
    const client = connect({
      serviceHost: {
        editRoutineByChat: async () => {
          throw new TimeoutError("The routine did not answer in time.", 90_000);
        },
      },
    });
    await expect(
      client.routines.editByChat({ routineId: "job-1", text: "at 9" })
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      defined: true,
      data: { ms: 90_000 },
    });
  });
});

// R5-T26 (main side): the routine start notice.
describe("routines.events (spec 05 §31.5 j)", () => {
  it("publishes run-started for a started attempt only, with no snapshot", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "routines-events-"));
    process.env.ABACUSAI_BOT_HOME = home;
    try {
      const job = createJob({ prompt: "p", schedule: "0 9 * * *" });
      // An earlier start: a new subscription never replays it.
      recordRun(job.id, "started session s-0", "manual", {
        kind: "started",
        sessionId: "s-0",
      });
      let attached!: () => void;
      const ready = new Promise<void>((resolve) => {
        attached = resolve;
      });
      const client = connect({
        serviceHost: {
          onRoutineRunStarted: (
            listener: Parameters<typeof onRoutineRunStarted>[0]
          ) => {
            const off = onRoutineRunStarted(listener);
            attached();
            return off;
          },
          // No hosted results in this test; the stream only attaches to them.
          onHostedRun: () => () => {},
          onRoutineCreatedByAgent: () => () => {},
        },
      });
      const events = await client.routines.events();
      const first = events.next();
      await ready;
      recordRun(
        job.id,
        "skipped: the previous run is still going",
        "schedule",
        {
          kind: "skipped",
        }
      );
      const attempt = recordRun(job.id, "started session s-1", "webhook", {
        kind: "started",
        sessionId: "s-1",
      });
      await expect(first).resolves.toEqual({
        done: false,
        value: {
          type: "run-started",
          routineId: job.id,
          attemptId: attempt!.id,
          trigger: "webhook",
          startedAt: attempt!.at,
        },
      });
      await events.return?.();
    } finally {
      delete process.env.ABACUSAI_BOT_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
