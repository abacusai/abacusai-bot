/**
 * A chat continued from another: its first message from the user carries the
 * old chat's summary once, beside any routine report, and a hand-off of a
 * chat whose agent has stopped starts that agent rather than failing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    { default: anything },
    {
      get: (target, property) =>
        property in target
          ? (target as Record<PropertyKey, unknown>)[property]
          : property === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});

const { ServiceHost } = await import("./service-host");
const { continuationNote } = await import("./services/session/continuation");

type Notes = { notes: string[]; taken: () => void };
const notesOf = ServiceHost.prototype["userMessageNotes"] as (
  this: unknown,
  sessionId: string,
  tags: unknown
) => Notes;

const host = (seed: string | null, reports: string[] = []) => {
  const taken = { seed: 0, reports: 0 };
  let current = seed;
  return {
    taken,
    self: {
      routineReportNotes: () => ({
        notes: reports,
        taken: () => (taken.reports += 1),
      }),
      agentSessionManagerService: {
        continuationSeed: () => current,
        takeContinuationSeed: () => {
          taken.seed += 1;
          current = null;
        },
      },
    },
  };
};

describe("the summary a continued chat's first message carries", () => {
  it("goes first, beside a routine report, and is spent once taken", () => {
    const { self, taken } = host("## Goal\nFix the login crash.", ["report"]);
    const owed = notesOf.call(self, "s2", undefined);
    expect(owed.notes).toEqual([
      continuationNote("## Goal\nFix the login crash."),
      "report",
    ]);
    expect(owed.notes[0]).toContain("Fix the login crash.");
    expect(owed.notes[0]).toContain("do not repeat an approach");
    owed.taken();
    expect(taken).toEqual({ seed: 1, reports: 1 });
    expect(notesOf.call(self, "s2", undefined).notes).toEqual(["report"]);
  });

  it("waits for the user's own words: a hidden operator turn or a routine fire does not carry it", () => {
    const { self } = host("## Goal\nFix it.");
    for (const tags of [
      { operator: { kind: "kickstart" } },
      { routineFire: true },
      { systemReminder: true },
    ])
      expect(notesOf.call(self, "s2", tags).notes).toEqual([]);
  });

  it("leaves a chat with none untouched", () => {
    const { self } = host(null, ["report"]);
    expect(notesOf.call(self, "s2", undefined).notes).toEqual(["report"]);
  });
});

describe("a hand-off of a chat whose agent has stopped", () => {
  const run = (results: Array<{ ok: boolean; reason?: string }>) => {
    const started: string[] = [];
    const self = {
      sendAgentAction: vi.fn(async () => results.shift()),
      startSessionAgent: vi.fn(async (id: string) => {
        started.push(id);
        return true;
      }),
    };
    return { self, started };
  };

  it("starts the agent and asks again", async () => {
    const { self, started } = run([
      { ok: false, reason: "not-running" },
      { ok: true, summary: "## Goal" } as never,
    ]);
    const result = await ServiceHost.prototype.runAgentAction.call(
      self as never,
      { workspaceId: "w1", sessionId: "s1", action: "handoff" }
    );
    expect(result).toEqual({ ok: true, summary: "## Goal" });
    expect(started).toEqual(["s1"]);
    expect(self.sendAgentAction).toHaveBeenCalledTimes(2);
  });

  it("leaves other commands, and other refusals, as they are", async () => {
    for (const [action, reason] of [
      ["compact", "not-running"],
      ["handoff", "busy"],
    ] as const) {
      const { self, started } = run([{ ok: false, reason }]);
      const result = await ServiceHost.prototype.runAgentAction.call(
        self as never,
        { workspaceId: "w1", sessionId: "s1", action }
      );
      expect(result).toEqual({ ok: false, reason });
      expect(started).toEqual([]);
    }
  });
});
