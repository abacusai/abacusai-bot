import assert from "node:assert/strict";
import { test } from "node:test";

import { geometryFailures } from "./check-workspace-geometry.mjs";
test("rejects an expanded outer half-gutter but accepts token gutters", () => {
  assert.equal(
    geometryFailures({
      token: 8,
      edges: { left: 4, right: 4, top: 4, bottom: 4 },
      gaps: [{ a: "chat", b: "files", axis: "x", value: 8 }],
    }).length,
    4
  );
  assert.deepEqual(
    geometryFailures({
      token: 8,
      edges: { left: 0, right: 0, top: 0, bottom: 0 },
      gaps: [{ a: "chat", b: "files", axis: "x", value: 8 }],
    }),
    []
  );
});
test("reports the offending island pair and dimension", () => {
  assert.match(
    geometryFailures({
      token: 8,
      edges: {},
      gaps: [{ a: "chat", b: "files", axis: "y", value: 12 }],
    })[0],
    /chat\/files y: 12px/
  );
});

test("rejects state-specific ancestor padding and reports its source element", () => {
  assert.match(
    geometryFailures({
      token: 8,
      edges: {},
      gaps: [],
      ancestor: [{ element: "session-dock", padding: "12px", margin: "0px" }],
    }).at(0),
    /session-dock padding: 12px/
  );
});

test("guards material ancestors while preserving opaque fallback modes", () => {
  const record = {
    token: 8,
    edges: {},
    gaps: [],
    material: true,
    ancestor: [
      {
        element: "session-dock",
        background: "rgb(255, 255, 255)",
        padding: "0px",
        margin: "0px",
      },
    ],
  };
  assert.match(geometryFailures(record)[0], /session-dock paints/);
  assert.deepEqual(geometryFailures({ ...record, material: false }), []);
});
