/**
 * Hosted routines in the panel: their state, their results' wording, the
 * unread mark, and the notice a finished run makes once.
 */
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import type { HostedRoutineRun } from "@abacus-ai/contract/routines";
import { describe, expect, it, vi } from "vitest";

import { routineState } from "./data";
import {
  createUnreadStore,
  deliveredKey,
  hostedRunFailed,
  hostedStatusKey,
  isHosted,
} from "./hosted";
import { createFireHandler, hostedRunNotice } from "./notify";

const lastRun = (status: string): HostedRoutineRun => ({
  id: "i1",
  routineId: "hosted-r1",
  name: "Digest",
  status,
  at: 1,
  deliveredVia: "email",
  delivered: true,
  summary: "Three meetings",
});

const hostedRow = (overrides: Partial<RoutineRow> = {}): RoutineRow =>
  ({
    id: "hosted-r1",
    name: "Digest",
    schedule: "0 8 * * *",
    runAt: null,
    webhookToken: null,
    prompt: "My calendar",
    workspaceId: null,
    botId: null,
    enabled: true,
    createdAt: 0,
    lastRunAt: null,
    lastResult: null,
    recentRuns: [],
    nextRunAt: null,
    webhookUrl: null,
    webhookPublicPending: false,
    botName: null,
    runner: "hosted",
    hosted: {
      kind: "task",
      timezone: "Asia/Kolkata",
      notify: "always",
      delivery: "default",
      sourceHosts: [],
      watchUrl: null,
      pausedReason: null,
      lastRun: null,
    },
    ...overrides,
  }) as RoutineRow;

describe("a hosted routine's state", () => {
  it("reads from its last run, not from sessions here", () => {
    expect(isHosted(hostedRow())).toBe(true);
    expect(routineState(hostedRow(), [], [])).toBe("scheduled");
    expect(
      routineState(
        hostedRow({
          hosted: { ...hostedRow().hosted!, lastRun: lastRun("timeout") },
        }),
        [],
        []
      )
    ).toBe("failed");
    expect(routineState(hostedRow({ enabled: false }), [], [])).toBe("paused");
    expect(routineState(hostedRow({ schedule: null, runAt: 5 }), [], [])).toBe(
      "once"
    );
  });

  it("words every status with a key of its own", () => {
    expect(hostedStatusKey("done")).toBe("routines.hosted.status.done");
    expect(hostedStatusKey("payment_required")).toBe(
      "routines.hosted.status.credits"
    );
    expect(hostedStatusKey("no_host")).toBe("routines.hosted.status.failed");
    expect(hostedStatusKey("execution_error")).toBe(
      "routines.hosted.status.failed"
    );
    expect(hostedStatusKey("running")).toBe("routines.hosted.status.running");
    expect(hostedStatusKey("done", false)).toBe("routines.hosted.status.quiet");
    expect(hostedStatusKey("something_new")).toBe(
      "routines.hosted.status.unknown"
    );
    expect(hostedRunFailed(lastRun("missed"))).toBe(true);
    expect(hostedRunFailed(lastRun("done"))).toBe(false);
    expect(deliveredKey("whatsapp")).toBe("routines.hosted.via.whatsapp");
    expect(deliveredKey(null)).toBeNull();
  });
});

describe("unread results", () => {
  it("counts new results per routine until its page is seen", () => {
    const store = createUnreadStore();
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    store.add("hosted-r1", "i1");
    store.add("hosted-r1", "i1");
    store.add("hosted-r1", "i2");
    store.add("hosted-r2", "i3");
    expect(store.count("hosted-r1")).toBe(2);
    expect(store.count()).toBe(3);
    store.read("hosted-r1");
    expect(store.count("hosted-r1")).toBe(0);
    expect(store.count()).toBe(1);
    expect(heard).toHaveBeenCalledTimes(4);
    stop();
  });
});

describe("the notice for a finished hosted run", () => {
  it("is made once per run, under the routine's own name", () => {
    const seen = new Set<string>();
    const event = { type: "hosted-run" as const, run: lastRun("done") };
    expect(hostedRunNotice(event, [hostedRow()], seen)).toEqual({
      run: event.run,
      routineId: "hosted-r1",
      name: "Digest",
      botId: null,
    });
    expect(hostedRunNotice(event, [hostedRow()], seen)).toBeNull();
  });

  it("leaves the fire cue alone, and the fire handler ignores it", () => {
    const play = vi.fn();
    createFireHandler(
      () => [hostedRow()],
      play
    )({
      type: "hosted-run",
      run: lastRun("done"),
    });
    expect(play).not.toHaveBeenCalled();
    expect(
      hostedRunNotice(
        {
          type: "run-started",
          routineId: "r",
          attemptId: "a",
          trigger: "schedule",
          startedAt: 0,
        },
        [],
        new Set()
      )
    ).toBeNull();
  });
});

describe("the hosted routine copy, in every language", () => {
  it("never offers the desktop app as the way around the plan", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(import.meta.dirname, "../../locales");
    const desktop =
      /desktop|escritorio|bureau|Arbeitsfläche|área de trabalho|デスクトップ|데스크톱|डेस्कटॉप|bot\.abacus\.ai/i;
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const locale = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const copy = JSON.stringify(locale.routines?.hosted ?? {});
      expect(copy, file).not.toMatch(desktop);
      expect(locale.routines.hosted.planRequired, file).toBeTruthy();
    }
  });
});
