import { describe, it, expect, vi } from "vitest";

import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";

import { createFireHandler, completionNotice } from "./notify";
const routine = { id: "r", name: "Briefing", botId: null } as RoutineRow;
describe("routine attention ownership", () => {
  it("R5-T26 fires only scheduled/webhook attempts once", () => {
    const play = vi.fn();
    const consume = createFireHandler(() => [routine], play);
    consume({
      type: "run-started",
      routineId: "r",
      attemptId: "a",
      trigger: "schedule",
      startedAt: 0,
    });
    consume({
      type: "run-started",
      routineId: "r",
      attemptId: "a",
      trigger: "schedule",
      startedAt: 0,
    });
    consume({
      type: "run-started",
      routineId: "r",
      attemptId: "b",
      trigger: "manual",
      startedAt: 0,
    });
    consume({
      type: "run-started",
      routineId: "r",
      attemptId: "c",
      trigger: "webhook",
      startedAt: 0,
    });
    expect(play.mock.calls).toEqual([
      ["r", null],
      ["r", null],
    ]);
  });
  it("R5-T40 ignores cancelled and unrelated completions", () => {
    const notice = {
      routineId: "r",
      outcome: "cancelled",
    } as RunFinishedNotice;
    expect(completionNotice(notice, [routine])).toBeNull();
    expect(
      completionNotice({ ...notice, outcome: "error" }, [routine])?.kind
    ).toBe("failed");
    expect(
      completionNotice({ ...notice, routineId: null, outcome: "success" }, [
        routine,
      ])
    ).toBeNull();
  });
});
