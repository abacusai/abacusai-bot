import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJob, updateJob } from "./cron-store";
import { MAX_WEBHOOK_BODY, WebhookService } from "./webhook-service";

let home: string;
let service: WebhookService | null = null;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webhooks-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  service?.stop();
  service = null;

  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * A request that does not outlive its own response.
 *
 * Every service here binds the same fixed port, so all these tests talk to one
 * origin, and `fetch` is undici, which pools connections per origin. A socket
 * pooled against one test's service was handed the next test's first request,
 * reaching a listener that had already stopped: ECONNRESET, on a call whose
 * assertion had nothing to do with it. That was main's only red test for a
 * day, and it never reproduced outside CI, where the fixed port is free and
 * the machine is loaded enough to lose the race.
 *
 * `Connection: close` retires each socket with its response, so there is
 * nothing left to inherit and no race to lose.
 */
const call = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: { ...init.headers, connection: "close" },
  });

const start = async (
  runJob = vi.fn().mockResolvedValue(undefined)
): Promise<{ base: string; runJob: ReturnType<typeof vi.fn> }> => {
  service = new WebhookService(runJob);
  await service.start();
  return { base: `http://127.0.0.1:${service.port()}`, runJob };
};

describe("firing a routine by webhook", () => {
  it("runs the job with the payload and answers before the run", async () => {
    const job = createJob({ webhook: true, prompt: "x" });
    const { base, runJob } = await start();

    const response = await call(`${base}/hooks/${job.webhookToken}`, {
      method: "POST",
      body: '{"event":"push"}',
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(runJob).toHaveBeenCalled());
    expect(runJob).toHaveBeenCalledWith(job.id, "webhook", '{"event":"push"}');
  });

  it("passes null for an empty body", async () => {
    const job = createJob({ webhook: true, prompt: "x" });
    const { base, runJob } = await start();

    await call(`${base}/hooks/${job.webhookToken}`, { method: "POST" });

    await vi.waitFor(() => expect(runJob).toHaveBeenCalled());
    expect(runJob).toHaveBeenCalledWith(job.id, "webhook", null);
  });

  it("truncates an oversized payload instead of dropping the fire", async () => {
    const job = createJob({ webhook: true, prompt: "x" });
    const { base, runJob } = await start();

    await call(`${base}/hooks/${job.webhookToken}`, {
      method: "POST",
      body: "y".repeat(MAX_WEBHOOK_BODY * 2),
    });

    await vi.waitFor(() => expect(runJob).toHaveBeenCalled());
    const payload = runJob.mock.calls[0][2] as string;
    expect(payload).toHaveLength(MAX_WEBHOOK_BODY);
  });
});

describe("what does not fire", () => {
  it("answers an unknown token and a paused job identically", async () => {
    const job = createJob({
      webhook: true,
      schedule: "0 9 * * *",
      prompt: "x",
    });
    updateJob(job.id, { enabled: false });
    const { base, runJob } = await start();

    const unknown = await call(`${base}/hooks/${"0".repeat(48)}`, {
      method: "POST",
    });
    const paused = await call(`${base}/hooks/${job.webhookToken}`, {
      method: "POST",
    });

    expect(unknown.status).toBe(404);
    expect(paused.status).toBe(404);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("refuses non-POST methods and unrelated paths", async () => {
    const job = createJob({ webhook: true, prompt: "x" });
    const { base, runJob } = await start();

    const got = await call(`${base}/hooks/${job.webhookToken}`);
    const elsewhere = await call(`${base}/anything`, { method: "POST" });

    expect(got.status).toBe(405);
    expect(elsewhere.status).toBe(404);
    expect(runJob).not.toHaveBeenCalled();
  });
});

describe("the listener", () => {
  it("falls back to an ephemeral port when the fixed one is taken", async () => {
    const first = new WebhookService(vi.fn());
    await first.start();
    const second = new WebhookService(vi.fn());
    await second.start();

    expect(second.port()).not.toBeNull();
    expect(second.port()).not.toBe(first.port());

    first.stop();
    second.stop();
  });
});
