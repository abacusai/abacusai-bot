/**
 * A long silent turn, replayed through the real session loop: a scripted
 * model and real bash, with each kill shrunk to a second. A "biggest files"
 * ask once ran three killed whole-folder scans over 27 minutes without a
 * word to the user. Now each kill tells the model to try a faster way and
 * say so, a hidden reminder asks for a line while the user hears nothing,
 * and both ride at the tail: the system prompt and every earlier message
 * stay byte-identical, so the cached prefix holds.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resetBackgroundJobs } from "./background-processes.js";
import type { DesktopEvent } from "./protocol.js";
import { AbacusBotSession } from "./session.js";

const REMINDER = "heard nothing from you for";
const FASTER = "Do not run it again with a larger `timeout`";

let provider: FakeProvider;
let home: string;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "progress-updates-home-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_AUDIENCE = "owner";
  // pi's own shell, whose deadline reports "Command timed out after N seconds".
  process.env.ABACUSAI_BOT_SANDBOX = "off";
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider)
  );
});

afterAll(async () => {
  delete process.env.ABACUSAI_BOT_AUDIENCE;
  delete process.env.ABACUSAI_BOT_SANDBOX;
  resetBackgroundJobs();
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A scan that outlives its one-second budget, as a whole-home `du` did. */
const slowScan = (seconds: number) => ({
  name: "bash",
  args: { command: `sleep ${seconds}`, timeout: 1 },
});

describe("a long silent turn", () => {
  it("gets the faster-way advice and capped reminders at the tail, with the prefix untouched", async () => {
    // Only the clock is faked: each model call "takes" five minutes of work.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const replies: Reply[] = [
        { call: slowScan(30) },
        { call: slowScan(31) },
        { call: slowScan(32) },
        { call: { name: "bash", args: { command: "echo listed" } } },
        { say: "The biggest files are in Videos." },
      ];
      provider.script((_call, index) => {
        vi.setSystemTime(Date.now() + 5 * 60_000);
        return replies[Math.min(index, replies.length - 1)]!;
      });
      const events: DesktopEvent[] = [];
      const session = new AbacusBotSession({
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "progress-updates-cwd-")),
        mode: "yolo",
        hostServices: false,
        emit: (event: DesktopEvent) => events.push(event),
      } as never);
      await session.start();
      await session.send("show my 5 biggest files");
      await session.stop();

      const calls = provider.calls;
      expect(calls).toHaveLength(5);
      const text = (call: (typeof calls)[number]) =>
        JSON.stringify(call.body.messages);
      const count = (call: (typeof calls)[number], needle: string) =>
        text(call).split(needle).length - 1;

      // Every kill carries the faster-way advice, never "re-run larger".
      expect(count(calls[3]!, FASTER)).toBe(3);
      expect(text(calls[3]!)).not.toContain("Re-run it with a larger");
      // A reminder after the first and second silent kills; two unanswered stop them.
      expect(calls.map((call) => count(call, REMINDER))).toEqual([
        0, 1, 2, 2, 2,
      ]);
      // Each reminder is the request's last message: appended, never inserted.
      for (const index of [1, 2]) {
        const messages = calls[index]!.body.messages as unknown[];
        expect(JSON.stringify(messages.at(-1))).toContain(REMINDER);
      }

      // The system prompt is byte-identical in every request, and each
      // request's messages are the next one's prefix.
      const system = (call: (typeof calls)[number]) =>
        JSON.stringify(
          (call.body.messages as Array<{ role: string }>).filter(
            (message) =>
              message.role === "system" || message.role === "developer"
          )
        );
      expect(system(calls[0]!)).toContain("keep the user posted");
      for (const call of calls) expect(system(call)).toBe(system(calls[0]!));
      for (let i = 1; i < calls.length; i++) {
        const before = calls[i - 1]!.body.messages as unknown[];
        const after = calls[i]!.body.messages as unknown[];
        expect(JSON.stringify(after.slice(0, before.length))).toBe(
          JSON.stringify(before)
        );
      }
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});
