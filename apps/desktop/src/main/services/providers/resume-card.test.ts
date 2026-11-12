import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import { describe, expect, it } from "vitest";

import { resumeCardAfterTurn, resumeCardAfterWrite } from "./resume-card";

const row = (resumeCard: PrefsRow["dismissals"]["resumeCard"]) =>
  ({ dismissals: { resumeCard } }) as PrefsRow;

describe("resumeCardAfterTurn", () => {
  it.each(["site", "file"] as const)(
    "a %s result is the chat to offer",
    (ending) => {
      expect(resumeCardAfterTurn("s", ending, 100)).toEqual({
        dismissals: {
          resumeCard: {
            sessionId: "s",
            resultAt: 100,
            wroteAt: 100,
            closedAt: null,
          },
        },
      });
    }
  );

  it.each(["question", "unfinished", "chat"] as const)(
    "a turn that ended on %s changes nothing",
    (ending) => {
      expect(resumeCardAfterTurn("s", ending, 100)).toBeNull();
    }
  );
});

describe("resumeCardAfterWrite", () => {
  const mark = { sessionId: "s", resultAt: 0, wroteAt: 0, closedAt: null };
  const later = 20 * 60 * 60 * 1000;

  it("restarts the wait when the user writes", () => {
    expect(resumeCardAfterWrite(row(mark), later)).toEqual({
      dismissals: { resumeCard: { ...mark, wroteAt: later } },
    });
  });

  it("writes nothing with no card, a closed one, or a message a moment ago", () => {
    expect(resumeCardAfterWrite(row(null), later)).toBeNull();
    expect(resumeCardAfterWrite(row(undefined), later)).toBeNull();
    expect(
      resumeCardAfterWrite(row({ ...mark, closedAt: 1 }), later)
    ).toBeNull();
    expect(resumeCardAfterWrite(row(mark), 60_000)).toBeNull();
  });
});
