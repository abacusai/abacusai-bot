/**
 * The relay poller against a live local stand-in for the platform: a real
 * HTTP server answering /v1/abacusaibot_hook_url and /v1/abacusaibot_hook_events,
 * so what is tested is the poller's actual register → drain → dispatch loop
 * over the wire, not stubbed internals.
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJob, updateJob } from "./cron-store";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

let platform: http.Server | null = null;
/** Events the fake platform will hand to the next drain. */
let pendingEvents: object[] = [];
let pendingDropped = 0;
let registered: string[] = [];

const startPlatform = (): Promise<number> =>
  new Promise((resolve) => {
    platform = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Connection", "close");
        if (req.url === "/v1/abacusaibot_hook_url") {
          const token = (JSON.parse(body) as { token: string }).token;
          registered.push(token);
          res.end(JSON.stringify({ path: `/v1/hooks/relay-${token}` }));
          return;
        }
        if (req.url === "/v1/abacusaibot_hook_events") {
          const events = pendingEvents;
          const dropped = pendingDropped;
          pendingEvents = [];
          pendingDropped = 0;
          res.end(JSON.stringify({ events, dropped }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    platform.listen(0, "127.0.0.1", () => {
      const address = platform?.address();
      resolve(
        typeof address === "object" && address != null ? address.port : 0
      );
    });
  });

let port: number;

vi.mock("../config/settings", () => ({
  credentialFor: () => "test-api-key",
}));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => `http://127.0.0.1:${port}/v1`,
}));

import { WebhookRelay } from "./webhook-relay";

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webhook-relay-"));
  process.env.ABACUSAI_BOT_HOME = home;
  pendingEvents = [];
  pendingDropped = 0;
  registered = [];
  port = await startPlatform();
});

afterEach(() => {
  platform?.close();
  platform = null;

  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

/** Drive one poll cycle directly. The interval timer is not what's under test. */
const tickOnce = async (relay: WebhookRelay): Promise<void> => {
  await (relay as unknown as { tick: () => Promise<void> }).tick();
};

describe("the relay poller", () => {
  it("registers each enabled hook and shows its public URL", async () => {
    const job = createJob({ webhook: true, prompt: "On payment, tell me." });
    const paused = createJob({ webhook: true, prompt: "Paused hook." });
    updateJob(paused.id, { enabled: false });
    const runs: string[] = [];
    const relay = new WebhookRelay(async (jobId) => {
      runs.push(jobId);
    });

    await tickOnce(relay);

    expect(registered).toContain(job.webhookToken);
    expect(registered).not.toContain(paused.webhookToken);
    expect(relay.publicUrlFor(job.webhookToken)).toBe(
      `http://127.0.0.1:${port}/v1/hooks/relay-${job.webhookToken}`
    );
    expect(runs).toEqual([]);
  });

  it("dispatches drained events to the routine that owns the token", async () => {
    const job = createJob({ webhook: true, prompt: "On payment, tell me." });
    const runs: Array<{ jobId: string; payload: string | null }> = [];
    const relay = new WebhookRelay(async (jobId, _trigger, payload) => {
      runs.push({ jobId, payload });
    });

    pendingEvents = [
      { token: job.webhookToken, body: '{"amount": 5}' },
      { token: "deadbeef".repeat(6), body: "for a deleted job" },
      { token: job.webhookToken, body: "big one", truncated: true },
    ];

    await tickOnce(relay);

    expect(runs).toEqual([
      { jobId: job.id, payload: '{"amount": 5}' },
      {
        jobId: job.id,
        payload: "big one\n[payload truncated by the relay at 64KB]",
      },
    ]);
  });

  it("does nothing without a webhook-triggered job", async () => {
    createJob({ schedule: "0 9 * * *", prompt: "No webhook here." });
    const relay = new WebhookRelay(async () => {});

    await tickOnce(relay);

    expect(registered).toEqual([]);
  });
});
