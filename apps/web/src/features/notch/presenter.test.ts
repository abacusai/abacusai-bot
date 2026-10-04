import { describe, expect, it } from "vitest";

import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import type {
  AttentionSummary,
  RunFinishedNotice,
  SessionRow,
} from "@abacus-ai/contract/contract";

import { presentNotch, type NotchInputs } from "./presenter";
const base = (): NotchInputs => ({
  sessions: [],
  bots: fixtureBots(),
  routines: [],
  summaries: new Map(),
  asks: [],
  notices: [],
  prefs: DEFAULT_PREFS,
  mainFocused: false,
  hovered: false,
  acks: new Set(),
  snoozed: new Set(),
});
const session = (id: string, phase = "idle"): SessionRow => ({
  ...fixtureSessions()[0]!,
  id,
  owner: null,
  routineId: null,
  turn: {
    isBusy: phase !== "idle",
    phase: phase as "idle",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
});
const notice = (
  id: string,
  outcome: RunFinishedNotice["outcome"] = "success",
  owner: RunFinishedNotice["owner"] = null
): RunFinishedNotice => ({
  threadId: id,
  runId: `r-${id}`,
  owner,
  routineId: null,
  at: Date.parse("2026-10-01T00:00:01Z"),
  outcome,
  hasVisibleAssistantText: true,
});
describe("R6-T16 pure priority director", () => {
  it("questions outrank older approvals, asks, failures and work", () => {
    const x = base();
    x.sessions = [
      session("a", "waiting_permission"),
      session("q", "waiting_permission"),
      session("work", "working"),
      session("ask"),
      session("error"),
    ];
    x.summaries = new Map([
      [
        "q",
        {
          threadId: "q",
          firstTitle: "Question",
          incarnation: "i",
          questions: 1,
          approvals: 0,
          oldestAt: 20,
        } as AttentionSummary,
      ],
    ]);
    x.asks = [{ id: "ask-id", sessionId: "ask", since: 10 }];
    x.notices = [{ notice: notice("error", "error"), age: 0 }];
    expect(presentNotch(x, 0).queue.map((a) => a.kind)).toEqual([
      "question",
      "approval",
      "connector-ask",
      "failed",
      "working",
    ]);
    expect(presentNotch(x, 0).faces.length).toBeLessThanOrEqual(3);
  });
  it("calm and quiet never auto-expand", () => {
    const x = base();
    x.sessions = [session("a", "waiting_permission")];
    x.mainFocused = true;
    expect(presentNotch(x, 0)).toMatchObject({
      route: "/idle",
      expanded: false,
    });
    x.mainFocused = false;
    x.prefs = {
      ...DEFAULT_PREFS,
      sounds: {
        ...DEFAULT_PREFS.sounds,
        quietHours: { enabled: true, start: "22:00", end: "08:00" },
      },
    };
    expect(presentNotch(x, new Date(2026, 9, 1, 23).getTime())).toMatchObject({
      route: "/idle",
      expanded: false,
      quietUntil: "08:00",
    });
  });
  it("done expires after visible dwell and cancelled emits no outcome", () => {
    const x = base();
    x.sessions = [session("a")];
    x.notices = [{ notice: notice("a"), age: 4999 }];
    expect(presentNotch(x, 0).route).toBe("/done");
    x.notices[0]!.age = 5000;
    expect(presentNotch(x, 0).route).toBe("/idle");
    x.notices = [{ notice: notice("a", "cancelled"), age: 0 }];
    expect(presentNotch(x, 0).queue).toEqual([]);
  });
  it("reply expands for six seconds and expires or acknowledges", () => {
    const x = base();
    x.sessions = [
      {
        ...session("a"),
        owner: { kind: "bot", botId: "bot", role: "forever", key: "forever" },
      },
    ];
    x.notices = [
      { notice: notice("a", "success", x.sessions[0]!.owner), age: 5999 },
    ];
    expect(presentNotch(x, 0)).toMatchObject({
      route: "/reply/$id",
      expanded: true,
    });
    x.notices[0]!.age = 6000;
    expect(presentNotch(x, 0).expanded).toBe(false);
    x.acks = new Set(["r-a"]);
    expect(presentNotch(x, 0).queue).toEqual([]);
  });
  it("a table transition to idle does not invent a completion", () => {
    const x = base();
    x.sessions = [session("a")];
    expect(presentNotch(x, 0).queue).toEqual([]);
  });
});
