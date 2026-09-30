/** R2-T9 (spec 02 §4.3): the STATE_DELTA subset. */
import { describe, expect, it } from "vitest";

import { applyEvent } from "./apply";
import { applyPatch } from "./json-patch";
import { emptyThreadState } from "./thread-store";

describe("R2-T9 json-patch", () => {
  const doc = { mode: "DEFAULT", modeSource: "startup", model: "m", "a/b": 1, "c~d": 2 };

  it("adds, replaces and removes without mutating", () => {
    const next = applyPatch(doc, [
      { op: "replace", path: "/mode", value: "PLAN" },
      { op: "add", path: "/plan", value: [{ content: "x", status: "pending" }] },
      { op: "remove", path: "/model" },
    ]);
    expect(next).toEqual({
      mode: "PLAN",
      modeSource: "startup",
      "a/b": 1,
      "c~d": 2,
      plan: [{ content: "x", status: "pending" }],
    });
    expect(doc.mode).toBe("DEFAULT");
  });

  it("unescapes pointers and appends with -", () => {
    expect(applyPatch(doc, [{ op: "replace", path: "/a~1b", value: 3 }])).toMatchObject({ "a/b": 3 });
    expect(applyPatch(doc, [{ op: "replace", path: "/c~0d", value: 4 }])).toMatchObject({ "c~d": 4 });
    expect(applyPatch({ list: [1] }, [{ op: "add", path: "/list/-", value: 2 }])).toEqual({ list: [1, 2] });
  });

  it("is idempotent for add/replace re-application", () => {
    const ops = [
      { op: "add", path: "/plan", value: [] },
      { op: "replace", path: "/mode", value: "PLAN" },
    ];
    const once = applyPatch(doc, ops);
    expect(applyPatch(once, ops)).toEqual(once);
  });

  it("refuses other ops and missing parents", () => {
    expect(applyPatch(doc, [{ op: "move", path: "/mode", value: 1 }])).toBeNull();
    expect(applyPatch(doc, [{ op: "add", path: "/x/y", value: 1 }])).toBeNull();
    expect(applyPatch(doc, [{ op: "replace", path: "/nope", value: 1 }])).toBeNull();
  });

  it("an unsupported delta clears agent state until the next snapshot", () => {
    const state = { ...emptyThreadState(0), agent: doc as never };
    const after = applyEvent(state, 1, { type: "STATE_DELTA", delta: [{ op: "copy", path: "/x", from: "/mode" }] } as never);
    expect(after.agent).toBeNull();
    const again = applyEvent(after, 2, { type: "STATE_DELTA", delta: [{ op: "replace", path: "/mode", value: "PLAN" }] } as never);
    expect(again.agent).toBeNull();
    const fresh = applyEvent(again, 3, { type: "STATE_SNAPSHOT", snapshot: doc } as never);
    expect(fresh.agent).toEqual(doc);
  });
});
