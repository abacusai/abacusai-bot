import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  catchUpWorthIt: vi.fn(() => true),
  claimSlot: vi.fn(),
  dueJobs: vi.fn(),
  getJob: vi.fn(),
  heldJobs: vi.fn(() => []),
  minuteOf: vi.fn((at: number) => at),
  missedJobs: vi.fn(() => []),
  recordRun: vi.fn(),
  retireOnceJob: vi.fn(),
  setHeld: vi.fn(),
  setMissed: vi.fn(),
  slotFor: vi.fn(() => 0),
}));
vi.mock("./cron-store", () => store);

const { CronScheduler } = await import("./cron-scheduler");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  store.setHeld.mockReset();
  store.setMissed.mockReset();
  store.recordRun.mockReset();
  store.claimSlot.mockReset();
  store.heldJobs.mockReset().mockReturnValue([]);
  store.missedJobs.mockReset().mockReturnValue([]);
});

const eperm = (): never => {
  throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
    code: "EPERM",
  });
};
const at = (minutes: number): Date => new Date(2026, 10, 4, 9, minutes, 5);

describe("a tick while the store refuses writes", () => {
  it("skips a job whose fire it cannot claim and still fires the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.dueJobs.mockReturnValue([
      { id: "once", runAt: 1, heldSince: null },
      { id: "daily", runAt: null, heldSince: null },
    ]);
    store.claimSlot.mockImplementation((id: string) => {
      if (id === "once")
        throw new Error("writes are blocked while a migration runs");
      return true;
    });
    const runJob = vi.fn(async () => {});

    await new CronScheduler(runJob).tick();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledWith(
      "daily",
      "schedule",
      expect.objectContaining({ slot: 0 })
    );
    expect(store.retireOnceJob).not.toHaveBeenCalled();
    expect(store.recordRun).not.toHaveBeenCalled();
  });

  it("fires what is due when the record of a missed fire cannot be saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const missed = { id: "missed", schedule: "0 9 * * *", heldSince: null };
    store.missedJobs.mockReturnValue([
      { job: missed, count: 1, latest: 1 },
    ] as never);
    store.dueJobs.mockReturnValue([
      { id: "due", runAt: null, heldSince: null },
    ]);
    store.claimSlot.mockReturnValue(true);
    store.setMissed.mockImplementation(eperm);
    const runJob = vi.fn(async () => {});

    await expect(
      new CronScheduler(runJob).tick(at(1))
    ).resolves.toBeUndefined();

    expect(runJob).toHaveBeenCalledWith(
      "due",
      "schedule",
      expect.objectContaining({ slot: 0 })
    );
  });

  it("looks again next tick for the make-up it could not hold", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const job = { id: "brief", schedule: "0 9 * * *", heldSince: null };
    store.dueJobs.mockReturnValue([]);
    store.missedJobs.mockReturnValue([{ job, count: 1, latest: 1 }] as never);
    store.setHeld.mockImplementationOnce(eperm);
    const scheduler = new CronScheduler(vi.fn(async () => {}));

    await scheduler.tick(at(1));
    await scheduler.tick(at(2));

    expect(store.missedJobs).toHaveBeenCalledTimes(2);
    expect(store.missedJobs).toHaveBeenLastCalledWith(null, at(2));
    expect(store.setHeld).toHaveBeenLastCalledWith("brief", at(2).getTime(), {
      slot: 1,
      reason: "catch-up",
    });
  });

  it("does not look again once the store takes its writes", async () => {
    store.dueJobs.mockReturnValue([]);
    const scheduler = new CronScheduler(vi.fn(async () => {}));

    await scheduler.tick(at(1));
    await scheduler.tick(at(2));

    expect(store.missedJobs).toHaveBeenCalledTimes(1);
  });

  it("finds a moment it could not claim on the next tick", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.dueJobs.mockReturnValueOnce([
      { id: "hourly", runAt: null, heldSince: null },
    ]);
    store.dueJobs.mockReturnValue([]);
    store.claimSlot.mockImplementationOnce(eperm);
    const scheduler = new CronScheduler(vi.fn(async () => {}));

    await scheduler.tick(at(1));
    await scheduler.tick(at(2));

    expect(store.missedJobs).toHaveBeenLastCalledWith(null, at(2));
  });

  it("keeps a hold it could not let go, and still fires the next", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const held = (id: string) => ({
      id,
      enabled: true,
      runAt: null,
      schedule: null,
      heldSince: 1,
      heldSlot: 1,
      heldFor: "network",
    });
    store.dueJobs.mockReturnValue([]);
    store.heldJobs.mockReturnValue([held("stuck"), held("next")] as never);
    store.claimSlot.mockReturnValue(true);
    store.setHeld.mockImplementation((id: string) => {
      if (id === "stuck") eperm();
    });
    const runJob = vi.fn(async (_id: string) => {});

    await new CronScheduler(
      runJob,
      async () => true,
      undefined,
      async () => {}
    ).release();

    expect(runJob.mock.calls.map(([id]) => id)).toEqual(["next"]);
  });

  it("survives saving that a run failed to start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.dueJobs.mockReturnValue([{ id: "a", runAt: null, heldSince: null }]);
    store.claimSlot.mockReturnValue(true);
    store.recordRun.mockImplementation(eperm);

    await expect(
      new CronScheduler(async () => {
        throw new Error("no session");
      }).tick(at(1))
    ).resolves.toBeUndefined();
  });
});
