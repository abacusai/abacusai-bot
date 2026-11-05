/**
 * A routine at the credit wall: a fire that cannot be paid for skips before
 * any session or model call, the routine keeps its schedule, the user is told
 * once however many fires skip, and the credits coming back ends all of it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createJob, getJob } from "./cron-store";
import { readLastRoutineRun } from "./routine-runs-store";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    {
      default: anything,
      app: {
        isPackaged: false,
        getPath: () => process.env.ABACUSAI_BOT_HOME,
        getVersion: () => "1.0.86",
        getLocale: () => "en-US",
        getPreferredSystemLanguages: () => ["en-US"],
      },
    },
    {
      get: (target, key) =>
        key in target
          ? (target as Record<PropertyKey, unknown>)[key]
          : key === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});
vi.mock("electron-store", () => ({
  default: class {
    private values: Record<string, unknown>;
    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.values = { ...options.defaults };
    }
    get(key: string, fallback?: unknown) {
      return this.values[key] ?? fallback;
    }
    set(key: string, value: unknown) {
      this.values[key] = value;
    }
    delete(key: string) {
      delete this.values[key];
    }
    onDidChange() {
      return () => {};
    }
  },
}));

const settings = vi.hoisted(() => ({ defaultModel: undefined as unknown }));
vi.mock("../config/settings", async (importActual) => {
  const actual = await importActual<typeof import("../config/settings")>();
  return {
    ...actual,
    readSettings: () => ({
      ...actual.readSettings(),
      apiKeys: { abacus: "key" },
      defaultModel: settings.defaultModel as string | undefined,
    }),
  };
});

const account = vi.hoisted(() => ({
  remaining: 0,
  /** What the read brings: main lifts the wall on an account with credits. */
  onRead: null as (() => void) | null,
}));
vi.mock("../providers/abacus", async (importActual) => ({
  ...(await importActual<typeof import("../providers/abacus")>()),
  creditSnapshot: () => ({
    remaining: account.remaining,
    granted: 2000,
    at: Date.now(),
  }),
  fetchAbacusAccount: async () => {
    account.onRead?.();
    return null;
  },
}));

const { ServiceHost } = await import("../../service-host");

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "routine-credit-wall-"));
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
  settings.defaultModel = undefined;
  account.remaining = 0;
  account.onRead = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const harness = async (
  seed: Partial<PrefsRow> = {},
  jobModel?: string | null
) => {
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  let row = {
    creditsExhaustedAt: Date.now(),
    freeLaneChosenAt: null,
    routineCreditHold: null,
    ...seed,
  } as PrefsRow;
  host.attachPrefs(() => ({
    get: () => row,
    update: (patch) => {
      const previous = row;
      row = { ...row, ...patch } as PrefsRow;
      host.prefsChanged(row, previous);
      return row;
    },
  }));
  vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
  vi.spyOn(internals, "updateAgentSessionLabel").mockImplementation(() => {});
  vi.spyOn(host, "ensureRoutineWorkspace").mockResolvedValue("w");
  const start = vi
    .spyOn(host, "startAgentSession")
    .mockResolvedValue({ success: true } as never);
  const send = vi
    .spyOn(host, "sendAgentMessage")
    .mockResolvedValue(true as never);
  const chatLine = vi
    .spyOn(internals.messagingGatewayService, "tellRoutinesOnHold")
    .mockResolvedValue(true);
  const job = createJob({
    schedule: "0 * * * *",
    prompt: "check",
    name: "R",
    ...(jobModel !== undefined ? { model: jobModel } : {}),
  });
  const fire = (trigger: "schedule" | "manual" | "webhook" = "schedule") =>
    host.runRoutine(job.id, trigger);
  const history = () =>
    getJob(job.id)?.runs.map(({ kind, result }) => ({ kind, result }));
  return {
    host,
    internals,
    start,
    send,
    chatLine,
    job,
    fire,
    history,
    row: () => row,
  };
};

const SKIPPED = {
  kind: "skipped-credits",
  result: "skipped: out of Abacus.AI credits",
};

it("skips a fire at the wall before any session or model call, and says so", async () => {
  const { internals, start, send, fire, job, history } = await harness();

  await expect(fire()).resolves.toBe("skipped");

  expect(start).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(internals.agentSessionManagerService.listByRoutine(job.id)).toEqual(
    []
  );
  expect(history()).toEqual([SKIPPED]);
  // The schedule stands: credits back, the next fire just runs.
  expect(getJob(job.id)?.enabled).toBe(true);
});

it("tells the user once, however many fires skip, until the credits are back", async () => {
  const { chatLine, fire, history, row } = await harness();

  await fire();
  await fire("webhook");
  await fire();

  expect(history()).toEqual([SKIPPED, SKIPPED, SKIPPED]);
  expect(chatLine).toHaveBeenCalledTimes(1);
  expect(row().routineCreditHold).toMatchObject({ noticed: false });
});

it("re-reads the account first, so a top-up starts that very run", async () => {
  const { host, start, fire, history, row } = await harness();
  await fire();
  expect(row().routineCreditHold).not.toBeNull();

  const internals = host as unknown as Record<string, any>;
  account.onRead = () => internals.prefs().update({ creditsExhaustedAt: null });
  await expect(fire()).resolves.toBe("started");

  expect(start).toHaveBeenCalledTimes(1);
  expect(row().routineCreditHold).toBeNull();
  expect(history()?.[0]?.kind).toBe("started");
});

it.each([
  [
    "the free models were chosen at the wall",
    { freeLaneChosenAt: Date.now() },
    undefined,
  ],
  ["no wall stands", { creditsExhaustedAt: null }, undefined],
  ["its model is on the user's own key", {}, "openai/gpt-5.6-luna"],
])("runs when %s", async (_case, seed, model) => {
  settings.defaultModel = model;
  const { start, fire, row } = await harness(seed);

  await expect(fire()).resolves.toBe("started");

  expect(start).toHaveBeenCalledTimes(1);
  expect(row().routineCreditHold).toBeNull();
});

it("reads the routine's own model, not the default, at the wall", async () => {
  settings.defaultModel = "openai/gpt-5.6-luna";
  const billed = await harness({}, "abacus/route-llm-code");
  await expect(billed.fire()).resolves.toBe("skipped");

  settings.defaultModel = undefined;
  const ownKey = await harness({}, "openai/gpt-5.6-luna");
  await expect(ownKey.fire()).resolves.toBe("started");
});

it("lets a person's Run through: the wall's own card answers them", async () => {
  const { start, fire } = await harness();

  await expect(fire("manual")).resolves.toBe("started");

  expect(start).toHaveBeenCalledTimes(1);
});

it("a wall past its day still skips while the account reads empty, not once it does not", async () => {
  const dayAgo = Date.now() - 25 * 60 * 60_000;
  const { start, fire } = await harness({ creditsExhaustedAt: dayAgo });

  await expect(fire()).resolves.toBe("skipped");
  expect(start).not.toHaveBeenCalled();

  account.remaining = 40;
  await expect(fire()).resolves.toBe("started");
});

it("a run the credits ran out under is filed as such, and pauses nothing", async () => {
  const { internals, fire, job, chatLine, row } = await harness({
    creditsExhaustedAt: null,
  });
  await fire();
  const [session] = internals.agentSessionManagerService.listByRoutine(job.id);
  internals.routineRunText.set(session.id, ["Checked one of two feeds."]);

  internals.settleRoutineRun({
    sessionId: session.id,
    kind: "error",
    startedAt: Date.now(),
    endedAt: Date.now(),
    error: { actions: [{ type: "upgrade-abacus", cause: "exhausted" }] },
  });

  expect(getJob(job.id)?.enabled).toBe(true);
  expect(row().routineCreditHold).toMatchObject({ routineId: job.id });
  expect(chatLine).toHaveBeenCalledTimes(1);
  const run = readLastRoutineRun(internals.routineHome(job));
  expect(run).toMatchObject({
    outcome: "failed",
    reply: "Checked one of two feeds.",
  });
  const file = fs.readdirSync(
    path.join(internals.routineHome(job), "runs")
  )[0]!;
  expect(
    fs.readFileSync(path.join(internals.routineHome(job), "runs", file), "utf8")
  ).toContain("- Stopped: out of Abacus.AI credits");
});

it("a hosted run at the wall reports no credits without a session", async () => {
  const { host, internals, start } = await harness();

  await expect(
    host.runUnattended({
      runKey: "rk",
      name: "Hosted",
      prompt: "check",
      notify: "always",
      payload: null,
      deadlineSecs: 60,
      sources: [],
      reads: [],
      watchUrl: null,
      timezone: "UTC",
      access: null,
    })
  ).resolves.toEqual({ outcome: "failed", text: "", creditsOut: true });

  expect(start).not.toHaveBeenCalled();
  expect(internals.hostedRunSessions.size).toBe(0);
});

it("marks every session nobody is in, and no chat", async () => {
  const { host, internals, job } = await harness({ creditsExhaustedAt: null });
  const sessions = internals.agentSessionManagerService;
  const routine = sessions.create("w", job.id, null, "schedule");
  const chat = sessions.create("w");
  const hosted = sessions.create("w");
  internals.hostedRunSessions.add(hosted.id);
  const ask = sessions.create("w");
  vi.spyOn(internals, "isBotAskSession").mockImplementation(
    (...args: unknown[]) => args[0] === ask.id
  );

  const envOf = async (id: string) =>
    (await host.buildAdditionalConfigEnv("code", id))
      .ABACUSAI_BOT_NOBODY_PRESENT;

  expect(await envOf(routine.id)).toBe("1");
  expect(await envOf(hosted.id)).toBe("1");
  expect(await envOf(ask.id)).toBe("1");
  expect(await envOf(chat.id)).toBeUndefined();
});
