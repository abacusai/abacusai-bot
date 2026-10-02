import { expect, it } from "vitest";

import { sessionAttention } from "./attention";
it("R4-T9 connector asks outrank running and errors outrank unread", () => {
  const row = {
    status: "running",
    turn: { phase: "streaming", isBusy: true, updatedAt: "today" },
  } as const;
  expect(sessionAttention(row, false, 1)).toMatchObject({
    kind: "needs-you",
    reason: "connector",
  });
  expect(sessionAttention(row, true, 0)).toMatchObject({ kind: "running" });
  expect(
    sessionAttention(
      { ...row, turn: { ...row.turn, phase: "error", isBusy: false } },
      true,
      0
    )
  ).toMatchObject({ kind: "error" });
});
