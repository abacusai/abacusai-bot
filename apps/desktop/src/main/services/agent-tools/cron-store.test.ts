import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMigrationWriteBlocks } from "../../migrations/write-block";
import { CronScheduler } from "./cron-scheduler";
import {
  claimSlot,
  createJob,
  onCronStoreWrite,
  onRoutineRunStarted,
  retireOnceJob,
  dueJobs,
  getJob,
  jobForWebhookToken,
  listJobs,
  missedJobs,
  recordRun,
  removeJob,
  updateJob,
} from "./cron-store";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-cron-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  setMigrationWriteBlocks(null);
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

describe("creating a routine", () => {
  it("keeps a manual job with neither trigger, and each trigger on its own", () => {
    const manual = createJob({ prompt: "do it" });
    expect(manual.schedule).toBeNull();
    expect(manual.webhookToken).toBeNull();

    const cronOnly = createJob({ schedule: "0 9 * * *", prompt: "do it" });
    const hookOnly = createJob({ webhook: true, prompt: "do it" });
    const both = createJob({
      schedule: "0 9 * * *",
      webhook: true,
      prompt: "do it",
    });

    expect(cronOnly.webhookToken).toBeNull();
    expect(hookOnly.schedule).toBeNull();
    expect(hookOnly.webhookToken).toMatch(/^[0-9a-f]{48}$/);
    expect(both.schedule).not.toBeNull();
    expect(both.webhookToken).not.toBeNull();
  });

  it("derives a name from the prompt when none is given", () => {
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "Summarize my inbox\nand more detail",
    });

    expect(job.name).toBe("Summarize my inbox");
    expect(
      createJob({ schedule: "0 9 * * *", prompt: "x", name: "Brief" }).name
    ).toBe("Brief");
  });

  it("carries the owning bot", () => {
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "x",
      botId: "bot-1",
    });

    expect(getJob(job.id)?.botId).toBe("bot-1");
  });
});

describe("the folder a routine runs in", () => {
  it("is settable after the fact, and clearable back to its own folder", () => {
    // Routines made from the pane start with none; the dialog's folder field
    // is how one made against a template that reads a repository gets one.
    const job = createJob({ prompt: "review the open PRs" });
    expect(job.workspaceId).toBeNull();

    expect(updateJob(job.id, { workspaceId: "ws-1" }).workspaceId).toBe("ws-1");
    expect(updateJob(job.id, { workspaceId: null }).workspaceId).toBeNull();
  });
});

describe("the webhook token", () => {
  it("resolves a job, and only an existing one", () => {
    const job = createJob({ webhook: true, prompt: "x" });

    expect(jobForWebhookToken(job.webhookToken ?? "")?.id).toBe(job.id);
    expect(jobForWebhookToken("deadbeef")).toBeNull();
    expect(jobForWebhookToken("")).toBeNull();
  });

  it("is minted once, kept across updates, and revoked for good", () => {
    const job = createJob({ webhook: true, prompt: "x" });
    const token = job.webhookToken;

    const kept = updateJob(job.id, { prompt: "y", webhook: true });
    expect(kept.webhookToken).toBe(token);

    const revoked = updateJob(job.id, {
      schedule: "0 9 * * *",
      webhook: false,
    });
    expect(revoked.webhookToken).toBeNull();

    const reminted = updateJob(job.id, { webhook: true });
    expect(reminted.webhookToken).not.toBe(token);
  });

  it("lets the last trigger go, leaving a manual job", () => {
    const job = createJob({ webhook: true, prompt: "x" });

    const manual = updateJob(job.id, { webhook: false });
    expect(manual.webhookToken).toBeNull();
    expect(manual.schedule).toBeNull();
  });
});

describe("run history", () => {
  it("records the trigger and keeps every run", () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });

    recordRun(job.id, "started session s1", "manual");
    recordRun(job.id, "delivered", "webhook");
    // Every fire is kept: the run is the routine's record, not a glance.
    for (let i = 0; i < 25; i++) recordRun(job.id, `run ${i}`);

    const stored = getJob(job.id);
    expect(stored?.runs).toHaveLength(27);
    // Newest first: the last write is the first row.
    expect(stored?.runs[0].result).toBe("run 24");
    expect(stored?.lastResult).toBe("run 24");
  });
});

describe("jobs written before routines existed", () => {
  it("read as plain cron jobs", () => {
    createJob({ schedule: "0 9 * * *", prompt: "old prompt" });
    const file = path.join(home, "cronjobs.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >[];
    delete raw[0].name;
    delete raw[0].webhookToken;
    delete raw[0].botId;
    delete raw[0].runs;
    fs.writeFileSync(file, JSON.stringify(raw));

    const job = listJobs()[0];
    expect(job.name).toBe("old prompt");
    expect(job.webhookToken).toBeNull();
    expect(job.botId).toBeNull();
    expect(job.runs).toEqual([]);
  });
});

describe("what the scheduler sees", () => {
  it("never ticks a webhook-only or paused job", () => {
    const at = new Date();
    const minute = at.getMinutes();
    const hour = at.getHours();

    const due = createJob({ schedule: `${minute} ${hour} * * *`, prompt: "x" });
    createJob({ webhook: true, prompt: "y" });
    const paused = createJob({
      schedule: `${minute} ${hour} * * *`,
      prompt: "z",
    });
    updateJob(paused.id, { enabled: false });

    expect(dueJobs(at).map((job) => job.id)).toEqual([due.id]);
  });
});

describe("removing", () => {
  it("throws on an unknown id", () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });

    removeJob(job.id);
    expect(() => removeJob(job.id)).toThrow();
  });
});

describe("a job that runs once", () => {
  it("is due from its moment on, until it has fired", () => {
    const at = new Date(2026, 8, 3, 17, 58).getTime();
    const job = createJob({ runAt: at, prompt: "ping" });
    expect(job.schedule).toBeNull();

    expect(dueJobs(new Date(at - 60_000)).map((j) => j.id)).not.toContain(
      job.id
    );
    expect(dueJobs(new Date(at)).map((j) => j.id)).toContain(job.id);
    // Slept through: an hour late, still due. Once means once, not never.
    expect(dueJobs(new Date(at + 3_600_000)).map((j) => j.id)).toContain(
      job.id
    );

    retireOnceJob(job.id);
    expect(getJob(job.id)?.enabled).toBe(false);
    expect(dueJobs(new Date(at + 3_600_000)).map((j) => j.id)).not.toContain(
      job.id
    );
  });

  it("re-arms when given a new time, and drops the time for a schedule", () => {
    const job = createJob({ runAt: 1_000, prompt: "ping" });
    retireOnceJob(job.id);

    const later = updateJob(job.id, { runAt: 2_000 });
    expect(later.enabled).toBe(true);
    expect(later.runAt).toBe(2_000);

    const repeating = updateJob(job.id, { schedule: "0 9 * * *" });
    expect(repeating.runAt).toBeNull();
    expect(repeating.schedule).toBe("0 9 * * *");
  });
});

describe("resuming a paused routine", () => {
  it("refuses a one-time routine that already ran, unless given a new time", () => {
    const job = createJob({
      schedule: null,
      webhook: false,
      prompt: "Once",
      runAt: Date.now() - 60_000,
    } as never);
    updateJob(job.id, { enabled: false });

    expect(() => updateJob(job.id, { enabled: true })).toThrow(/already ran/);
    expect(
      updateJob(job.id, { enabled: true, runAt: Date.now() + 60_000 }).enabled
    ).toBe(true);
  });

  it("marks when it was resumed, so earlier failures do not count", () => {
    const job = createJob({
      schedule: "0 9 * * *",
      webhook: false,
      prompt: "Daily",
    } as never);
    updateJob(job.id, { enabled: false });
    const before = Date.now();

    expect(
      updateJob(job.id, { enabled: true }).resumedAt ?? 0
    ).toBeGreaterThanOrEqual(before);
  });
});

describe("minted ids", () => {
  it("never reuse a caller's id that looks minted, with a frozen clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    try {
      const first = createJob({ prompt: "one", schedule: "0 9 * * *" });
      const [, now, count] = /^job-(\d+)-(\d+)$/.exec(first.id)!;
      createJob(
        { prompt: "two", schedule: "0 9 * * *" },
        `job-${now}-${Number(count) + 1}`
      );
      const third = createJob({ prompt: "three", schedule: "0 9 * * *" });
      const ids = listJobs().map((job) => job.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toContain(third.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("damaged history and migration recovery", () => {
  it("keeps every routine and malformed history value across an edit", () => {
    const a = createJob({ prompt: "a" });
    const b = createJob({ prompt: "b" });
    const file = path.join(home, "cronjobs.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const malformed = [null, { at: 1, trigger: "manual" }, 7];
    raw[0].runs = [...malformed, { at: 1, trigger: "manual", result: "fired" }];
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(listJobs().map((job) => job.id)).toEqual([a.id, b.id]);
    updateJob(b.id, { name: "changed" });
    recordRun(a.id, "no workspace to run in");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(
      saved[0].runs.filter(
        (run: unknown) =>
          run == null || typeof run !== "object" || !("result" in run)
      )
    ).toEqual(malformed);
    expect(saved).toHaveLength(2);
  });

  it("lists the readable routines past an entry it cannot read, and keeps that entry verbatim across a save", () => {
    const a = createJob({ prompt: "a" });
    const file = path.join(home, "cronjobs.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const bad = [null, { id: 7 }];
    fs.writeFileSync(file, JSON.stringify([raw[0], ...bad]));

    expect(listJobs().map((job) => job.id)).toEqual([a.id]);
    const b = createJob({ prompt: "b" });
    updateJob(a.id, { name: "changed" });
    removeJob(b.id);

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const readable = (job: { id?: unknown } | null) =>
      typeof job?.id === "string";
    expect(
      saved
        .filter(readable)
        .map((job: { id: string; name: string }) => [job.id, job.name])
    ).toEqual([[a.id, "changed"]]);
    expect(saved.filter((job: never) => !readable(job))).toEqual(bad);
  });

  describe("a routine saved without an id", () => {
    const legacy = {
      name: "Inbox",
      schedule: "0 9 * * *",
      prompt: "Summarize my inbox",
      enabled: true,
      createdAt: 1_700_000_000_000,
      lastRunAt: 1_700_000_100_000,
      lastResult: "started session s1",
      runs: [
        {
          at: 1_700_000_100_000,
          trigger: "schedule",
          result: "started session s1",
        },
      ],
    };
    const file = () => path.join(home, "cronjobs.json");
    const seed = () => {
      const a = createJob({ prompt: "a" });
      const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
      fs.writeFileSync(file(), JSON.stringify([raw[0], legacy, null]));
      return a;
    };

    it("gets a derived id, saved once, and its history beside it", () => {
      const a = seed();
      const listed = listJobs();
      const recovered = listed.find((job) => job.name === "Inbox")!;
      expect(listed.map((job) => job.id)).toEqual([a.id, recovered.id]);
      expect(recovered.id).toMatch(/^job-recovered-[0-9a-f]{12}$/);
      expect(recovered.runs).toEqual([
        expect.objectContaining({ kind: "started", sessionId: "s1" }),
      ]);
      const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
      expect(saved).toEqual([
        expect.objectContaining({ id: a.id }),
        { ...legacy, id: recovered.id },
        null,
      ]);
      const text = fs.readFileSync(file(), "utf8");
      expect(listJobs().map((job) => job.id)).toEqual([a.id, recovered.id]);
      expect(fs.readFileSync(file(), "utf8")).toBe(text);
    });

    it("can be edited and removed", () => {
      seed();
      const id = listJobs()[1]!.id;
      updateJob(id, { name: "Renamed" });
      expect(getJob(id)?.name).toBe("Renamed");
      removeJob(id);
      const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
      expect(saved).toHaveLength(2);
      expect(saved[1]).toBeNull();
    });

    it("gets the same id on the launch after a crash before it was saved", () => {
      seed();
      const before = fs.readFileSync(file(), "utf8");
      const spy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw new Error("crash");
      });
      const first = listJobs()[1]!.id;
      spy.mockRestore();
      expect(fs.readFileSync(file(), "utf8")).toBe(before);
      expect(listJobs()[1]!.id).toBe(first);
      expect(JSON.parse(fs.readFileSync(file(), "utf8"))[1].id).toBe(first);
    });

    it("is not saved while the file is held, and is saved once it is not", () => {
      seed();
      const before = fs.readFileSync(file(), "utf8");
      setMigrationWriteBlocks({
        unresolved: [{ attempt: "step-5", destinations: [file()] }],
      } as never);
      const id = listJobs()[1]!.id;
      expect(fs.readFileSync(file(), "utf8")).toBe(before);
      setMigrationWriteBlocks(null);
      expect(listJobs()[1]!.id).toBe(id);
      expect(JSON.parse(fs.readFileSync(file(), "utf8"))[1].id).toBe(id);
    });
  });

  it("refuses to overwrite a corrupt nonempty job file", () => {
    const file = path.join(home, "cronjobs.json");
    fs.writeFileSync(file, "{broken");
    expect(() => createJob({ prompt: "new" })).toThrow("cannot be read");
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
  });

  // A crash can leave the file its full length in NUL bytes.
  it("restores the routines from the last good copy when the file is NUL-filled", () => {
    const first = createJob({ schedule: "0 9 * * *", prompt: "morning" });
    const second = createJob({ prompt: "on demand" });
    const file = path.join(home, "cronjobs.json");
    const nul = "\0".repeat(fs.statSync(file).size);
    fs.writeFileSync(file, nul);

    expect(listJobs().map((job) => job.id)).toEqual([first.id, second.id]);
    expect(
      (JSON.parse(fs.readFileSync(file, "utf8")) as { id: string }[]).map(
        (job) => job.id
      )
    ).toEqual([first.id, second.id]);
    const aside = fs
      .readdirSync(home)
      .filter((name) => name.startsWith("cronjobs.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, aside[0]!), "utf8")).toBe(nul);

    const third = createJob({ prompt: "after" });
    expect(listJobs().map((job) => job.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("never writes an empty list over a NUL-filled file with no good copy", () => {
    const file = path.join(home, "cronjobs.json");
    const nul = "\0".repeat(3000);
    fs.writeFileSync(file, nul);

    expect(listJobs()).toEqual([]);
    expect(() => createJob({ prompt: "new" })).toThrow(
      /cannot be read[\s\S]*do not delete, empty, or overwrite it/
    );
    expect(fs.readFileSync(file, "utf8")).toBe(nul);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it.each(["EACCES", "ENOSPC"])(
    "refuses blocked edits and run history when the journal fails with %s",
    (code) => {
      const job = createJob({ prompt: "a" });
      const file = path.join(home, "cronjobs.json");
      const before = fs.readFileSync(file, "utf8");
      setMigrationWriteBlocks({
        unresolved: [{ attempt: "step-5", destinations: [file] }],
      } as never);
      updateJob(job.id, { name: "durably held" });
      const journalDir = path.join(home, "threads", ".pending");
      const journal = path.join(
        journalDir,
        fs.readdirSync(journalDir).find((name) => name.endsWith(".json"))!
      );
      const durable = fs.readFileSync(journal, "utf8");
      const ioError = Object.assign(new Error(code), { code });
      // The atomic writer opens its staged file before writing it.
      const openFile = fs.openSync;
      const spy = vi
        .spyOn(fs, "openSync")
        .mockImplementation((target, ...args) => {
          if (String(target).startsWith(journalDir + path.sep)) throw ioError;
          return openFile(target, ...args);
        });
      const wrote = vi.fn();
      const started = vi.fn();
      const offWrite = onCronStoreWrite(wrote);
      const offStarted = onRoutineRunStarted(started);
      try {
        expect(() => updateJob(job.id, { name: "undurable" })).toThrow(ioError);
        expect(() =>
          recordRun(job.id, "started session s", "manual", { sessionId: "s" })
        ).toThrow(ioError);
        expect(wrote).not.toHaveBeenCalled();
        expect(started).not.toHaveBeenCalled();
        expect(getJob(job.id)).toMatchObject({
          name: "durably held",
          runs: [],
        });
        expect(fs.readFileSync(file, "utf8")).toBe(before);
        expect(fs.readFileSync(journal, "utf8")).toBe(durable);
      } finally {
        spy.mockRestore();
        offWrite();
        offStarted();
      }
      setMigrationWriteBlocks(null);
      expect(getJob(job.id)).toMatchObject({ name: "durably held", runs: [] });
    }
  );

  it.each([false, true])(
    "holds runtime cron writes while migration is unresolved (unknown=%s)",
    (unknown) => {
      const a = createJob({ prompt: "a" });
      const file = path.join(home, "cronjobs.json");
      const before = fs.readFileSync(file, "utf8");
      setMigrationWriteBlocks({
        unresolved: [
          { attempt: "step-5", destinations: unknown ? null : [file] },
        ],
      } as never);
      if (unknown) {
        expect(() => recordRun(a.id, "no workspace to run in")).toThrow(
          "migration recovery"
        );
        expect(fs.readFileSync(file, "utf8")).toBe(before);
        return;
      }
      recordRun(a.id, "no workspace to run in");
      updateJob(a.id, { name: "held" });
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(getJob(a.id)).toMatchObject({
        name: "held",
        runs: [expect.objectContaining({ kind: "no-workspace" })],
      });
      setMigrationWriteBlocks(null);
      expect(getJob(a.id)?.name).toBe("held");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))[0].name).toBe("held");
    }
  );
});

describe("full access and a rewrite", () => {
  it("keeps the access the user chose when the instruction or the reach changes", () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "summarise" });
    expect(job.access).toBeUndefined();
    expect(
      updateJob(job.id, { prompt: "email everyone" }).access
    ).toBeUndefined();
    updateJob(job.id, { access: "unattended" });
    expect(
      updateJob(job.id, {
        prompt: "summarise again",
        reach: { sources: ["https://news.example/"], reads: [] },
      }).access
    ).toBe("unattended");
  });

  it("keeps full access the same change gives again", () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "a" });
    expect(updateJob(job.id, { prompt: "b", access: "full" }).access).toBe(
      "full"
    );
  });
});

describe("a fire that comes due without a network", () => {
  // Made just before the first tick, as a routine made while the app runs.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 13, 8, 50) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A scheduler whose network the test controls, and the runs it started. */
  const scheduler = () => {
    const state = { online: false, held: 0 };
    const runs: string[] = [];
    const cron = new CronScheduler(
      async (id) => {
        runs.push(id);
      },
      async () => state.online,
      () => {
        state.held += 1;
      },
      async () => {}
    );
    return { cron, runs, state };
  };

  it("is held, not failed, and runs once when the network is back", async () => {
    const job = createJob({ schedule: "*/5 * * * *", prompt: "x" });
    const { cron, runs, state } = scheduler();

    await cron.tick(new Date(2026, 9, 13, 9, 0));
    expect(runs).toEqual([]);
    expect(cron.isHeld(job.id)).toBe(true);
    expect(state.held).toBeGreaterThan(0);
    // Nothing in its history says it failed.
    expect(getJob(job.id)?.runs).toEqual([]);

    state.online = true;
    await cron.release();
    expect(runs).toEqual([job.id]);
    expect(cron.isHeld(job.id)).toBe(false);
  });

  it("collapses every missed fire into one run", async () => {
    const job = createJob({ schedule: "*/5 * * * *", prompt: "x" });
    const { cron, runs, state } = scheduler();

    for (const minute of [0, 5, 10, 15])
      await cron.tick(new Date(2026, 9, 13, 9, minute));
    state.online = true;
    await cron.release();
    await cron.release();

    expect(runs).toEqual([job.id]);
  });

  it("files a held fire as skipped offline when its next fire comes first, never failed", async () => {
    const job = createJob({ schedule: "*/5 * * * *", prompt: "x" });
    const { cron } = scheduler();

    await cron.tick(new Date(2026, 9, 13, 9, 0));
    await cron.tick(new Date(2026, 9, 13, 9, 5));
    await cron.tick(new Date(2026, 9, 13, 9, 10));

    const kinds = getJob(job.id)?.runs.map((entry) => entry.kind);
    expect(kinds).toEqual(["skipped-offline", "skipped-offline"]);
    expect(getJob(job.id)?.runs[0]?.result).toMatch(/no network/);
    // The newest fire is still held, to run when the network is back.
    expect(cron.isHeld(job.id)).toBe(true);
  });

  it("keeps a held fire across a restart, shown as held, and runs it once when back", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    await scheduler().cron.tick(new Date(2026, 9, 13, 9, 0));

    // A new process: nothing in memory, the hold read off disk.
    const { cron, runs, state } = scheduler();
    expect(cron.isHeld(job.id)).toBe(true);
    await cron.tick(new Date(2026, 9, 13, 9, 30));
    expect(runs).toEqual([]);

    state.online = true;
    await cron.tick(new Date(2026, 9, 13, 9, 31));
    await cron.release();
    expect(runs).toEqual([job.id]);
    expect(cron.isHeld(job.id)).toBe(false);
  });

  it("runs a held fire on the first tick back, beside nothing else", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    const { cron, runs, state } = scheduler();

    await cron.tick(new Date(2026, 9, 13, 9, 0));
    state.online = true;
    await cron.tick(new Date(2026, 9, 13, 9, 1));

    expect(runs).toEqual([job.id]);
  });

  it("runs once after a sleep that slept through its fires", async () => {
    const job = createJob({ schedule: "*/10 * * * *", prompt: "x" });
    const { cron, runs, state } = scheduler();
    state.online = true;

    await cron.tick(new Date(2026, 9, 13, 8, 51));
    // Asleep from 8:51 to 9:33: four fires missed, one run.
    await cron.tick(new Date(2026, 9, 13, 9, 33));

    expect(runs).toEqual([job.id]);
    expect(getJob(job.id)?.missed?.count).toBe(4);
    // Made up: the catch-up's moment accounts for every fire before it.
    expect(
      missedJobs(new Date(2026, 9, 13, 8, 51), new Date(2026, 9, 13, 9, 33))
    ).toEqual([]);
  });

  it("never probes the network on a tick with nothing due", async () => {
    vi.setSystemTime(new Date(2026, 9, 13, 9, 30));
    createJob({ schedule: "0 9 * * *", prompt: "x" });
    const ready = vi.fn(async () => true);
    const cron = new CronScheduler(async () => {}, ready);

    await cron.tick(new Date(2026, 9, 13, 10, 0));

    expect(ready).not.toHaveBeenCalled();
  });
});

describe("fires missed while the app was closed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 13, 8, 55) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A process just started: its first tick has no tick before it. */
  const relaunch = () => {
    const runs: string[] = [];
    const cron = new CronScheduler(
      async (id) => {
        runs.push(id);
      },
      async () => true,
      () => {},
      async () => {}
    );
    return { cron, runs };
  };

  it("are counted from its last run and run once on the first tick", async () => {
    const job = createJob({ schedule: "*/10 * * * *", prompt: "x" });
    vi.setSystemTime(new Date(2026, 9, 13, 9, 0, 5));
    recordRun(job.id, "started session s", "schedule", { kind: "started" });

    // Closed after 9:00; opened at 9:33: 9:10, 9:20 and 9:30 were missed.
    const { cron, runs } = relaunch();
    await cron.tick(new Date(2026, 9, 13, 9, 33));

    expect(runs).toEqual([job.id]);
    expect(getJob(job.id)?.missed).toEqual({
      count: 3,
      at: new Date(2026, 9, 13, 9, 33).getTime(),
    });
  });

  it("count none for a routine made just before the app opened", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    const { cron, runs } = relaunch();
    await cron.tick(new Date(2026, 9, 13, 8, 56));

    expect(runs).toEqual([]);
    expect(getJob(job.id)?.missed ?? null).toBeNull();
  });

  it("count only the schedule's fires after its fire on creation", async () => {
    const job = createJob({ schedule: "*/10 * * * *", prompt: "x" });
    vi.setSystemTime(new Date(2026, 9, 13, 8, 55, 10));
    recordRun(job.id, "started session s", "create", { kind: "started" });

    const { cron } = relaunch();
    await cron.tick(new Date(2026, 9, 13, 9, 25));

    // 9:00, 9:10 and 9:20; the run at creation is none of them.
    expect(getJob(job.id)?.missed?.count).toBe(3);
  });

  it("start after a schedule change, and after a resume", async () => {
    const changed = createJob({ webhook: true, prompt: "x" });
    const paused = createJob({ schedule: "*/10 * * * *", prompt: "y" });
    updateJob(paused.id, { enabled: false });
    vi.setSystemTime(new Date(2026, 9, 13, 9, 25));
    updateJob(changed.id, { schedule: "*/10 * * * *" });
    updateJob(paused.id, { enabled: true });

    const { cron } = relaunch();
    await cron.tick(new Date(2026, 9, 13, 9, 45));

    expect(getJob(changed.id)?.missed?.count).toBe(2);
    expect(getJob(paused.id)?.missed?.count).toBe(2);
  });

  it("are cleared by its next on-time fire, not by the catch-up", async () => {
    const job = createJob({ schedule: "*/10 * * * *", prompt: "x" });
    const { cron } = relaunch();
    await cron.tick(new Date(2026, 9, 13, 9, 25));
    expect(getJob(job.id)?.missed?.count).toBe(3);

    await cron.tick(new Date(2026, 9, 13, 9, 26));
    expect(getJob(job.id)?.missed?.count).toBe(3);
    await cron.tick(new Date(2026, 9, 13, 9, 30));
    expect(getJob(job.id)?.missed ?? null).toBeNull();
  });
});

describe("each scheduled moment", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 13, 8, 0) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fresh process; `record` false is one that quit before writing the run down. */
  const launch = (record = true) => {
    const fires: Array<{ id: string; trigger: string; slot: number }> = [];
    const waits: number[] = [];
    const cron = new CronScheduler(
      async (id, trigger, fire) => {
        fires.push({ id, trigger, slot: fire.slot });
        if (record)
          recordRun(id, "started session s", trigger, {
            kind: "started",
            id: fire.attemptId,
          });
      },
      async () => true,
      () => {},
      async (ms) => {
        waits.push(ms);
      }
    );
    return { cron, fires, waits };
  };

  it("fires once when the app restarts within its minute", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    vi.setSystemTime(new Date(2026, 9, 13, 9, 0, 5));
    const first = launch();
    await first.cron.tick(new Date(2026, 9, 13, 9, 0, 5));
    expect(first.fires).toHaveLength(1);

    vi.setSystemTime(new Date(2026, 9, 13, 9, 0, 40));
    const second = launch();
    await second.cron.tick(new Date(2026, 9, 13, 9, 0, 40));

    expect(second.fires).toEqual([]);
    expect(getJob(job.id)?.firedSlot?.at).toBe(
      new Date(2026, 9, 13, 9, 0).getTime()
    );
  });

  it("never fires again after a quit before its run was written down", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    vi.setSystemTime(new Date(2026, 9, 13, 9, 0, 5));
    await launch(false).cron.tick(new Date(2026, 9, 13, 9, 0, 5));
    expect(getJob(job.id)?.runs).toEqual([]);

    vi.setSystemTime(new Date(2026, 9, 13, 9, 3));
    const relaunched = launch();
    await relaunched.cron.tick(new Date(2026, 9, 13, 9, 3));

    expect(relaunched.fires).toEqual([]);
    expect(getJob(job.id)?.missed ?? null).toBeNull();
  });

  it("records the run under the attempt that claimed it", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    vi.setSystemTime(new Date(2026, 9, 13, 9, 0, 5));
    await launch().cron.tick(new Date(2026, 9, 13, 9, 0, 5));

    const stored = getJob(job.id);
    expect(stored?.runs[0]?.id).toBe(stored?.firedSlot?.attemptId);
  });

  it("makes up a long sleep with one catch-up, for the latest missed fire only", async () => {
    vi.setSystemTime(new Date(2026, 9, 13, 9, 5));
    const job = createJob({ schedule: "0 * * * *", prompt: "x" });
    const { cron, fires } = launch();
    await cron.tick(new Date(2026, 9, 13, 9, 5));
    // Asleep until 14:10: 10:00 to 14:00 were missed.
    vi.setSystemTime(new Date(2026, 9, 13, 14, 10));
    await cron.tick(new Date(2026, 9, 13, 14, 10));
    vi.setSystemTime(new Date(2026, 9, 13, 14, 11));
    await cron.tick(new Date(2026, 9, 13, 14, 11));

    expect(fires).toEqual([
      {
        id: job.id,
        trigger: "catch-up",
        slot: new Date(2026, 9, 13, 14, 0).getTime(),
      },
    ]);
    expect(getJob(job.id)?.missed?.count).toBe(5);

    // Nor does a relaunch make it up again.
    vi.setSystemTime(new Date(2026, 9, 13, 14, 20));
    const relaunched = launch();
    await relaunched.cron.tick(new Date(2026, 9, 13, 14, 20));
    expect(relaunched.fires).toEqual([]);
  });

  it("skips a missed fire older than a day", async () => {
    // Mondays at 9, made on a Monday morning; the app opens on Tuesday at 10.
    vi.setSystemTime(new Date(2026, 9, 12, 8, 0));
    const job = createJob({ schedule: "0 9 * * 1", prompt: "x" });
    vi.setSystemTime(new Date(2026, 9, 13, 10, 0));
    const { cron, fires } = launch();
    await cron.tick(new Date(2026, 9, 13, 10, 0));

    expect(fires).toEqual([]);
    expect(getJob(job.id)?.heldSince ?? null).toBeNull();
    expect(getJob(job.id)?.missed?.count).toBe(1);
  });

  it("skips a missed fire when the next one is about to come", async () => {
    createJob({ schedule: "0 * * * *", prompt: "x" });
    vi.setSystemTime(new Date(2026, 9, 13, 9, 50));
    const { cron, fires } = launch();
    await cron.tick(new Date(2026, 9, 13, 9, 50));

    expect(fires).toEqual([]);
  });

  it("spaces out the catch-ups a launch lets go together", async () => {
    createJob({ schedule: "0 9 * * *", prompt: "x" });
    createJob({ schedule: "30 9 * * *", prompt: "y" });
    vi.setSystemTime(new Date(2026, 9, 13, 12, 0));
    const { cron, fires, waits } = launch();
    await cron.tick(new Date(2026, 9, 13, 12, 0));

    expect(fires.map((fire) => fire.trigger)).toEqual(["catch-up", "catch-up"]);
    expect(waits).toEqual([30_000]);
  });

  it("fires a one-time routine once, then retires it", async () => {
    const job = createJob({
      runAt: new Date(2026, 9, 13, 9, 2).getTime(),
      prompt: "x",
    });
    const { cron, fires } = launch();
    for (const minute of [1, 2, 3, 4]) {
      vi.setSystemTime(new Date(2026, 9, 13, 9, minute));
      await cron.tick(new Date(2026, 9, 13, 9, minute));
    }

    expect(fires).toHaveLength(1);
    expect(getJob(job.id)?.enabled).toBe(false);
    vi.setSystemTime(new Date(2026, 9, 13, 9, 10));
    await launch().cron.tick(new Date(2026, 9, 13, 9, 10));
    expect(fires).toHaveLength(1);
  });
});

describe("a fired moment from a clock that ran ahead", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 13, 8, 0) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is ignored, so the routine still fires once the clock is right", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    // Claimed while the clock read a week ahead.
    claimSlot(job.id, new Date(2026, 9, 20, 9, 0).getTime(), "attempt-ahead");
    vi.setSystemTime(new Date(2026, 9, 13, 9, 0, 5));

    expect(
      dueJobs(new Date(2026, 9, 13, 9, 0, 5)).map((due) => due.id)
    ).toEqual([job.id]);
  });

  it("is dropped when the schedule or one-time moment changes", () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "x" });
    claimSlot(job.id, new Date(2026, 9, 13, 9, 0).getTime(), "attempt-1");

    expect(updateJob(job.id, { schedule: "0 10 * * *" }).firedSlot).toBeNull();
    claimSlot(job.id, new Date(2026, 9, 13, 10, 0).getTime(), "attempt-2");
    expect(
      updateJob(job.id, { runAt: new Date(2026, 9, 14, 9, 0).getTime() })
        .firedSlot
    ).toBeNull();
  });
});
