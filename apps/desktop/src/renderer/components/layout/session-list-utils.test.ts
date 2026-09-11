/**
 * The sidebar's date buckets, borrowed from the DeepAgent chat list.
 */
import { describe, expect, it } from "vitest";

import { groupSessionsForSidebar } from "./session-list-utils";

const DAY = 24 * 60 * 60 * 1000;
// A fixed local noon, so day arithmetic is not at the mercy of the zone.
const now = new Date(2026, 8, 7, 12, 0, 0).getTime();
const at = (daysBack: number, hour = 9): number =>
  new Date(2026, 8, 7 - daysBack, hour).getTime();

describe("groupSessionsForSidebar", () => {
  it("buckets today, yesterday, a few days back by count, then by date", () => {
    const groups = groupSessionsForSidebar(
      [
        { id: "a", at: at(0) },
        { id: "b", at: at(1) },
        { id: "c", at: at(3) },
        { id: "d", at: at(3, 15) },
        { id: "e", at: at(20) },
        { id: "f", at: at(400) },
      ],
      (s) => s.at,
      now
    );

    expect(groups.map((g) => g.bucket.kind)).toEqual([
      "today",
      "yesterday",
      "daysAgo",
      "date",
      "date",
    ]);
    expect(groups[2]!.bucket).toEqual({ kind: "daysAgo", count: 3 });
    // Two chats on the same day share a group, newest first.
    expect(groups[2]!.sessions.map((s) => s.id)).toEqual(["d", "c"]);
    expect(groups[4]!.bucket).toMatchObject({ kind: "date", sameYear: false });
  });

  it("orders newest first regardless of input order", () => {
    const groups = groupSessionsForSidebar(
      [
        { id: "old", at: now - 10 * DAY },
        { id: "new", at: now - 1000 },
      ],
      (s) => s.at,
      now
    );
    expect(groups[0]!.sessions[0]!.id).toBe("new");
  });
});
