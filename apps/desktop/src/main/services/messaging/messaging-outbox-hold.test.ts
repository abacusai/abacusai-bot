/**
 * A message the app owes the user's own chat can wait for a moment (quiet
 * hours), lapse unsent (a stale report), and give way to a newer one of the
 * same kind, all kept on disk across a restart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatOutbox } from "./messaging-outbox";

const outboxes: ChatOutbox[] = [];
afterEach(() => {
  for (const outbox of outboxes.splice(0)) outbox.dispose();
});

/** An outbox on a real file, a clock and a chat that may be down. */
const open = (file: string, clock: { now: number }, up = { value: true }) => {
  const sent: string[] = [];
  const told: string[] = [];
  const outbox = new ChatOutbox({
    now: () => clock.now,
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    write: (state) => fs.writeFileSync(file, JSON.stringify(state)),
    send: async (message) => {
      if (!up.value) return false;
      sent.push(message.text);
      return true;
    },
    waitingOnLink: () => !up.value,
    giveUp: async (message) => {
      told.push(message.id);
    },
  });
  outboxes.push(outbox);
  return { outbox, sent, told };
};

const owed = (id: string, text: string, extra: object = {}) => ({
  id,
  platform: "whatsapp" as const,
  chatId: "",
  toSelf: true,
  text,
  userName: null,
  firstFailedAt: 0,
  ...extra,
});

const tempFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "outbox-hold-")), "o.json");

describe("an owed message with a hold, an expiry and a replace key", () => {
  it("waits until its moment, without counting a try, then goes once", async () => {
    const clock = { now: 1_000 };
    const { outbox, sent, told } = open(tempFile(), clock);
    outbox.owe(owed("r1", "Report", { notBefore: 5_000 }), 0);
    await outbox.flush();
    await outbox.flush();
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(told).toEqual([]);
    clock.now = 5_000;
    await outbox.flush();
    expect(sent).toEqual(["Report"]);
    expect(outbox.isDone("r1")).toBe(true);
  });

  it("lapses unsent past its expiry, with nobody told", async () => {
    const clock = { now: 0 };
    const up = { value: false };
    const { outbox, sent, told } = open(tempFile(), clock, up);
    outbox.owe(owed("r1", "Old report", { expiresAt: 10_000 }), 0);
    await outbox.flush();
    clock.now = 10_001;
    up.value = true;
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(told).toEqual([]);
    expect(outbox.size).toBe(0);
  });

  it("gives way to a newer message with the same key", async () => {
    const clock = { now: 0 };
    const up = { value: false };
    const { outbox, sent } = open(tempFile(), clock, up);
    outbox.owe(owed("r1", "Old: say go?", { replaces: "routine:job-1" }), 0);
    outbox.owe(owed("r2", "New.", { replaces: "routine:job-1" }), 0);
    outbox.owe(owed("x", "Other routine", { replaces: "routine:job-2" }), 0);
    up.value = true;
    await outbox.flush();
    expect(sent).toEqual(["New.", "Other routine"]);
  });

  it("is still owed after a restart, and goes once its chat is back", async () => {
    const file = tempFile();
    const clock = { now: 0 };
    const down = { value: false };
    const before = open(file, clock, down);
    before.outbox.owe(owed("r1", "Report", { expiresAt: 60_000 }), 0);
    await before.outbox.flush();
    before.outbox.dispose();

    const after = open(file, clock, { value: true });
    expect(after.outbox.size).toBe(1);
    // A replayed delivery owes it again under the same id: nothing doubles.
    expect(after.outbox.owe(owed("r1", "Report"), 0)).toBe(false);
    await after.outbox.flush();
    expect(after.sent).toEqual(["Report"]);
    expect(open(file, clock).outbox.owe(owed("r1", "Report"), 0)).toBe(false);
  });
});
