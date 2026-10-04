import { describe, expect, it } from "vitest";

import type { AttentionSummary, RunFinishedNotice } from "@abacus-ai/contract/contract";

import { cueForNotice } from "./cues";
import { applyAttention, emptyAttention } from "./events";
const item = (threadId: string): AttentionSummary => ({
  threadId,
  incarnation: "i",
  approvals: 1,
  questions: 0,
  oldestAt: 1,
  firstTitle: "Allow?",
});
describe("R6-T44 revisioned attention", () => {
  it("folds an atomic snapshot, rejects stale events and removes retired incarnations", () => {
    let state = applyAttention(emptyAttention(), {
      type: "snapshot",
      revision: 4,
      items: [item("a"), item("b"), item("c")],
    });
    state = applyAttention(state, {
      type: "remove",
      revision: 5,
      threadId: "b",
    });
    state = applyAttention(state, {
      type: "upsert",
      revision: 3,
      item: item("b"),
    });
    expect([...state.items.keys()]).toEqual(["a", "c"]);
    expect(state.revision).toBe(5);
    state = applyAttention(emptyAttention(), {
      type: "snapshot",
      revision: 0,
      items: [item("new")],
    });
    expect([...state.items.keys()]).toEqual(["new"]);
  });
});
describe("R6-T22 shared notice-to-cue table", () => {
  const notice = (
    owner: RunFinishedNotice["owner"],
    routineId: string | null,
    outcome: RunFinishedNotice["outcome"],
    text: boolean
  ): RunFinishedNotice => ({
    threadId: "t",
    runId: "r",
    owner,
    routineId,
    outcome,
    hasVisibleAssistantText: text,
    at: 0,
  });
  const bot = {
    kind: "bot" as const,
    botId: "b",
    role: "forever" as const,
    key: "forever",
  };
  it.each([
    [bot, null, "success", true, "received"],
    [bot, null, "success", false, null],
    [null, "check-in", "success", false, "done"],
    [null, "ordinary", "success", false, "done"],
    [null, null, "success", false, "done"],
    [bot, null, "error", false, "failed"],
    [null, null, "error", true, "failed"],
    [bot, null, "cancelled", true, null],
  ])("maps %j %j %j %j to %s", (owner, routineId, outcome, text, cue) => {
    expect(
      cueForNotice(
        notice(
          owner as typeof bot,
          routineId as string | null,
          outcome as RunFinishedNotice["outcome"],
          text as boolean
        ),
        { checkInRoutineIds: new Set(["check-in"]) }
      )
    ).toEqual(cue ? { kind: cue, dedupeKey: "r" } : null);
  });
});
