import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMigrationWriteBlocks } from "../../migrations/write-block";
import {
  createJob,
  onCronStoreWrite,
  onRoutineRunStarted,
  retireOnceJob,
  dueJobs,
  getJob,
  jobForWebhookToken,
  listJobs,
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

  it("refuses to overwrite a corrupt nonempty job file", () => {
    const file = path.join(home, "cronjobs.json");
    fs.writeFileSync(file, "{broken");
    expect(() => createJob({ prompt: "new" })).toThrow("cannot be read");
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
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
      const writeFile = fs.writeFileSync;
      const spy = vi
        .spyOn(fs, "writeFileSync")
        .mockImplementation((target, ...args) => {
          if (String(target).startsWith(journalDir + path.sep)) throw ioError;
          return writeFile(target, ...args);
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
