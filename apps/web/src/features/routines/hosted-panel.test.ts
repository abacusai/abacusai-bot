/**
 * The Routines panel's hosted fixes: a quiet run makes no notice, an absence
 * is one summary, the server's refusals in words, and what a local routine
 * left out of its sources.
 */
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import type { HostedRoutineRun } from "@abacus-ai/contract/routines";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";

import { routineState } from "./data";
import { runRoutineNow } from "./hosted-sync";
import { hostedAwayNotice, hostedRunNotice, remember } from "./notify";
import { routineRefusal } from "./refusal";
import { droppedSources, nextPreview, wallTimeIn } from "./schema";

const toast = vi.hoisted(() => ({ showInfo: vi.fn(), showError: vi.fn() }));
vi.mock("#renderer/lib/toast", () => toast);

const run = (
  id: string,
  overrides: Partial<HostedRoutineRun> = {}
): HostedRoutineRun => ({
  id,
  routineId: "hosted-r1",
  name: "Digest",
  status: "done",
  at: 1,
  deliveredVia: "whatsapp",
  delivered: true,
  summary: "Three meetings",
  ...overrides,
});

const row = (overrides: Partial<RoutineRow> = {}): RoutineRow =>
  ({
    id: "hosted-r1",
    name: "Digest",
    schedule: "0 8 * * *",
    runAt: null,
    enabled: true,
    botId: null,
    runner: "hosted",
    hosted: {
      kind: "task",
      timezone: "Asia/Kolkata",
      lastRun: null,
    },
    ...overrides,
  }) as RoutineRow;

describe("hosted run notices", () => {
  it("a run that sent nothing gets no notice, sound or unread mark", () => {
    const seen = new Set<string>();
    const quiet = run("q", { delivered: false });
    expect(
      hostedRunNotice({ type: "hosted-run", run: quiet }, [row()], seen)
    ).toBeNull();
    // Still seen: it never comes back as new.
    expect(seen.has("q")).toBe(true);
    expect(
      hostedRunNotice({ type: "hosted-run", run: run("d") }, [row()], seen)
    ).toMatchObject({ routineId: "hosted-r1", name: "Digest" });
  });

  it("a failed run is told even though nothing was delivered", () => {
    const failed = run("f", { status: "timeout", delivered: false });
    expect(
      hostedRunNotice({ type: "hosted-run", run: failed }, [row()], new Set())
    ).not.toBeNull();
  });

  it("an absence is one summary of the runs worth telling, once each", () => {
    const seen = new Set<string>(["old"]);
    const runs = hostedAwayNotice(
      {
        type: "hosted-away",
        runs: [run("old"), run("a"), run("q", { delivered: false }), run("b")],
      },
      [row()],
      seen
    );
    expect(runs?.map((entry) => entry.run.id)).toEqual(["a", "b"]);
    expect(
      hostedAwayNotice({ type: "hosted-away", runs: [run("a")] }, [row()], seen)
    ).toBeNull();
  });

  it("remembers only the latest notices", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) remember(seen, `n${i}`);
    expect(seen.size).toBe(500);
    expect(seen.has("n0")).toBe(false);
    expect(seen.has("n599")).toBe(true);
    expect(remember(seen, "n599")).toBe(false);
  });
});

describe("hosted routines while the server has them off", () => {
  it("every hosted row reads as paused; local ones are unchanged", () => {
    expect(routineState(row(), [], [], undefined, true)).toBe("paused");
    expect(
      routineState(
        row({ runner: "local", hosted: undefined, webhookToken: null }),
        [],
        [],
        undefined,
        true
      )
    ).toBe("scheduled");
  });
});

describe("the server's refusals, in words", () => {
  const precondition = (reason: string, detail?: string) =>
    new ORPCError("PRECONDITION_FAILED", {
      defined: true,
      status: 412,
      data: detail == null ? { reason } : { reason, detail },
    });

  it.each([
    ["plan-required", "routines.hosted.planRequired"],
    ["plan-interval", "routines.refused.planInterval"],
    ["plan-kind", "routines.refused.planKind"],
  ])("the free plan's %s offers the upgrade", (reason, key) => {
    expect(
      routineRefusal(precondition(reason, "https://up.example/x"))
    ).toEqual({
      key,
      upgrade: true,
      upgradeUrl: "https://up.example/x",
      field: null,
    });
  });

  it.each([
    ["routine-limit", "routines.hosted.atLimit"],
    ["no-host", "routines.refused.noHost"],
    ["routine-not-active", "routines.refused.notActive"],
    ["routine-busy", "routines.refused.busy"],
    ["queue-full", "routines.refused.queueFull"],
    ["wrong-bot", "routines.refused.wrongBot"],
    ["routines-off", "routines.refused.off"],
  ])("%s is its own message, with no upgrade", (reason, key) => {
    expect(routineRefusal(precondition(reason))).toMatchObject({
      key,
      upgrade: false,
    });
  });

  it("a refused value names its field", () => {
    const refused = new ORPCError("BAD_REQUEST", {
      defined: true,
      status: 400,
      data: { refusal: "sources", field: "sources" },
    });
    expect(routineRefusal(refused)).toMatchObject({
      key: "routines.refused.sources",
      field: "sources",
    });
  });

  it("anything else is not a refusal", () => {
    expect(routineRefusal(new Error("x"))).toBeNull();
    expect(
      routineRefusal(
        new ORPCError("BAD_REQUEST", {
          defined: true,
          status: 400,
          data: { field: "schedule", detail: "bad cron" },
        })
      )
    ).toBeNull();
  });
});

describe("running a hosted routine", () => {
  it("asks the server to run it", () => {
    const run = vi.fn(async () => "started" as const);
    const transport = {
      client: { routines: { run } },
    } as unknown as Transport;
    const t = ((key: string) => key) as never;
    runRoutineNow(row(), transport, t);
    expect(run).toHaveBeenCalledWith({ id: "hosted-r1", trigger: "manual" });
  });
});

describe("the form's sources and times", () => {
  it("names the sources a local routine did not keep", () => {
    expect(
      droppedSources(
        ["news.example.com", "https://blog.example.org/tech", "localhost:3000"],
        ["https://news.example.com/", "https://blog.example.org/tech"]
      )
    ).toEqual(["localhost:3000"]);
  });

  it("reads a hosted cron in its own zone's wall clock", () => {
    const now = new Date(Date.UTC(2026, 9, 8, 6, 30));
    const wall = wallTimeIn(now, "Asia/Kolkata");
    expect([wall.getHours(), wall.getMinutes()]).toEqual([12, 0]);
    const next = nextPreview(
      {
        preset: "custom",
        time: "09:00",
        weekday: 1,
        custom: "0 13 * * *",
        runAt: "",
      },
      now,
      "Asia/Kolkata"
    );
    expect([next?.getDate(), next?.getHours()]).toEqual([8, 13]);
  });
});
