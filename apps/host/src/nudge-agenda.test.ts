import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingWait } from "#main/services/agent-tools/pending-waits";

import { NudgeAgenda, nudgeNotes, waitItem } from "./nudge-agenda";
import { PhoneLane } from "./phone-lane";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-agenda-"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-09T06:00:00Z");

const gmail: PendingWait = {
  itemId: "connect:gmail",
  kind: "connector",
  stage: "link_sent",
  site: null,
  label: "Gmail",
  since: NOW - 60_000,
  expiresAt: NOW + 23 * 60 * 60_000,
};

const agenda = (
  options: {
    waits?: PendingWait[];
    refuse?: string;
  } = {}
) => {
  const calls: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const nudges = new NudgeAgenda(
    {
      call: (async (body: Record<string, unknown>) => {
        calls.push(body);
        if (options.refuse != null) throw new Error(options.refuse);
        return { ok: true };
      }) as never,
      phoneDir: dir,
      waits: async () => options.waits ?? [],
      now: () => NOW,
      log: (line) => logs.push(line),
    },
    { debounceMs: 5_000, checkEveryMs: 15_000 }
  );
  return { nudges, calls, logs };
};

const writeLoops = (loops: unknown[]): void =>
  fs.writeFileSync(path.join(dir, "open-loops.json"), JSON.stringify(loops));

describe("the check-in agenda", () => {
  it("posts on the first poll of every start, empty when there is nothing, so a previous host's items clear", async () => {
    const { nudges, calls } = agenda();
    nudges.start();
    nudges.polled({});
    nudges.polled({});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ action: "nudge_agenda", items: [] });
    nudges.stop();
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    nudges.stop();
  });

  it("carries due loops, connector links and the language, value-free", async () => {
    writeLoops([
      {
        id: "L1",
        text: "Passport renewal slot",
        due: "2026-10-09T10:30",
        status: "open",
      },
    ]);
    fs.writeFileSync(
      path.join(dir, "checkins.json"),
      JSON.stringify({ language: "es" })
    );
    const { nudges, calls } = agenda({ waits: [gmail] });
    nudges.start();
    nudges.polled({ tz: "Asia/Kolkata" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      action: "nudge_agenda",
      lang: "es",
      items: [
        {
          item_id: "loop:L1",
          kind: "due",
          at: Date.parse("2026-10-09T05:00:00Z") / 1000,
          expires_at: Date.parse("2026-10-09T18:29:00Z") / 1000,
          summary: "Passport renewal slot (due 2026-10-09T10:30)",
        },
        {
          item_id: "connect:gmail",
          kind: "connect",
          at: (gmail.since + 2 * 60 * 60_000) / 1000,
          expires_at: gmail.expiresAt / 1000,
          summary: "Gmail link was sent and is not connected yet.",
        },
      ],
    });
    nudges.stop();
  });

  it("makes the server's zone the loop's clock", () => {
    const { nudges, logs } = agenda();
    nudges.start();
    nudges.polled({ tz: "Europe/Madrid" });
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"))
    ).toEqual({ timezone: "Europe/Madrid" });
    nudges.polled({ tz: "Not/AZone" });
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"))
    ).toEqual({ timezone: "Europe/Madrid" });
    expect(logs).toContain("[phone] timezone Europe/Madrid");
    nudges.stop();
  });

  it("posts again after every turn, changed or not, a few seconds later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const { nudges, calls } = agenda();
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    nudges.turnEnded();
    nudges.turnEnded();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    nudges.stop();
  });

  it("posts between turns only when the agenda changed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const waits: PendingWait[] = [];
    const { nudges, calls } = agenda({ waits });
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toHaveLength(1);
    waits.push(gmail);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.items).toHaveLength(1);
    nudges.stop();
  });

  it("leaves a server without the action alone after saying so once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const { nudges, calls, logs } = agenda({
      refuse: "action must be one of pair, status, inbox",
    });
    nudges.start();
    nudges.polled({});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    nudges.turnEnded();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(
      logs.filter((line) => line.includes("agenda not taken"))
    ).toHaveLength(1);
    nudges.stop();
  });

  it("never names more than the server keeps", async () => {
    writeLoops(
      Array.from({ length: 14 }, (_, index) => ({
        id: `L${index + 1}`,
        text: `Loop ${index + 1}`,
        due: "2026-10-10",
        status: "open",
      }))
    );
    const { nudges } = agenda();
    expect((await nudges.build()).items).toHaveLength(10);
  });

  it("turns a wait into an item with its name and stage only", () => {
    expect(waitItem(gmail).summary).toBe(
      "Gmail link was sent and is not connected yet."
    );
  });
});

describe("what the loop hears with a user message", () => {
  it("the check-ins sent since, and a bare STOP, as tagged parts that are never the user's words", () => {
    const notes = nudgeNotes({
      id: "m1",
      text: "STOP",
      stop_keyword: true,
      nudges_sent: [
        { at: 1, text: "Your passport\n slot is today at 10:30." },
        { at: 2, text: "" },
      ],
    });
    expect(notes).toEqual([
      '[check-ins sent] Since the user\'s last message the app texted them: "Your passport slot is today at 10:30.". Their message may answer that.',
      expect.stringMatching(
        /^\[stop keyword\] .*change nothing until they say\.$/
      ),
    ]);
    // The loop's consent checks skip a part that opens with a host tag.
    for (const note of notes) expect(note).toMatch(/^\[[a-z][a-z -]*\] /);
  });

  it("nothing extra for a plain message", () => {
    expect(nudgeNotes({ id: "m1", text: "hi" })).toEqual([]);
  });

  it("reaches the session ahead of the message, and each poll reports its zone", async () => {
    const send = vi.fn(async () => true);
    const polled = vi.fn();
    let polls = 0;
    const phone = new PhoneLane(
      {
        call: (async (body: Record<string, unknown>) => {
          if (body.action !== "inbox") return { ok: true };
          polls += 1;
          if (polls > 1) await new Promise(() => {});
          return {
            tz: "Asia/Kolkata",
            messages: [
              {
                id: "m1",
                text: "yes please",
                nudges_sent: [{ at: 1, text: "Gmail isn't connected yet." }],
              },
            ],
          };
        }) as never,
        hasKey: () => true,
        openSession: async () => ({ workspaceId: "w", sessionId: "s" }),
        stop: async () => {},
        send,
        onAgentEvent: () => () => {},
        activity: () => {},
        resolveMedia: () => ({ ok: false, reason: "none" }),
        onPolled: polled,
        log: () => {},
      },
      { batchMs: 0 }
    );
    phone.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(polled).toHaveBeenCalledWith(
      expect.objectContaining({ tz: "Asia/Kolkata" })
    );
    expect(send).toHaveBeenCalledWith(
      "w",
      "s",
      "[check-ins sent] Since the user's last message the app texted them: \"Gmail isn't connected yet.\". Their message may answer that.\n\nyes please",
      "m1"
    );
    phone.stop();
  });
});
