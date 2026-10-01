import { expect, it } from "vitest";

import { DEFAULT_PREFS } from "#next/data/db/prefs";
import { fixtureBots, fixtureSessions } from "#next/data/fixture-db/rows";

import { presentNotch } from "./presenter";
import { activeSnoozes, permissionLineageKey, type Snooze } from "./snooze";
it("snoozes one descriptor for ten minutes, retains its count and expires unchanged attention", () => {
  const lineage = permissionLineageKey({
    threadId: "s",
    incarnation: "i",
    turnSeq: 1,
    permissionId: "p",
  });
  const records = new Map<string, Snooze>([
    [
      lineage,
      {
        lineage,
        summaryKey: "s:i:100",
        sessionId: "s",
        expiresAt: 600_100,
        connector: false,
      },
    ],
  ]);
  const inputs = {
    sessions: [{ ...fixtureSessions()[0]!, id: "s" }],
    bots: fixtureBots(),
    routines: [],
    summaries: new Map([
      [
        "s",
        {
          threadId: "s",
          incarnation: "i",
          oldestAt: 100,
          questions: 0,
          approvals: 1,
          firstTitle: null,
        },
      ],
    ]),
    asks: [],
    notices: [],
    prefs: DEFAULT_PREFS,
    mainFocused: false,
    hovered: false,
    acks: new Set<string>(),
    snoozed: activeSnoozes(records, 600_099, () => lineage),
  };
  const snoozed = presentNotch(inputs, 600_099);
  expect(snoozed.route).toBe("/idle");
  expect(snoozed.remaining).toBe(1);
  expect(snoozed.queue).toHaveLength(1);
  expect(
    presentNotch(
      { ...inputs, snoozed: activeSnoozes(records, 600_100, () => lineage) },
      600_100
    ).route
  ).toBe("/approval/$id");
  const replacement = permissionLineageKey({
    threadId: "s",
    incarnation: "i",
    turnSeq: 1,
    permissionId: "new",
  });
  expect(
    presentNotch(
      { ...inputs, snoozed: activeSnoozes(records, 101, () => replacement) },
      101
    ).route
  ).toBe("/approval/$id");
});
