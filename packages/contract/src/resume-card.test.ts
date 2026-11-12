import { expect, it } from "vitest";

import { RESUME_CARD_AWAY_MS, resumeCardDue } from "./resume-card";

const mark = {
  sessionId: "s",
  resultAt: 1_000,
  wroteAt: 1_000,
  closedAt: null,
};

it.each<[string, Parameters<typeof resumeCardDue>[0], number, boolean]>([
  ["no result on record", null, 1_000 + RESUME_CARD_AWAY_MS, false],
  ["away long enough", mark, 1_000 + RESUME_CARD_AWAY_MS, true],
  ["not away long enough", mark, RESUME_CARD_AWAY_MS, false],
  [
    "a message since the result",
    { ...mark, wroteAt: 5_000 },
    1_000 + RESUME_CARD_AWAY_MS,
    false,
  ],
  ["closed", { ...mark, closedAt: 2_000 }, 1_000 + RESUME_CARD_AWAY_MS, false],
])("%s", (_case, value, now, due) => {
  expect(resumeCardDue(value, now)).toBe(due);
});
