import assert from "node:assert/strict";
import { test } from "node:test";

import { processRoles } from "./perf-process-roles.mjs";

test("attributes shared renderers and includes idle agents in the total", () => {
  assert.deepEqual(processRoles({ pid: 10, command: "/app/main" }, 10), [
    "main",
  ]);
  assert.deepEqual(
    processRoles({ pid: 11, command: "electron --thread-id synthetic" }, 10),
    ["agent"]
  );
  assert.deepEqual(
    processRoles({ pid: 12, command: "electron --type=renderer" }, 10, [
      { pid: 12, role: "renderer" },
      { pid: 12, role: "notch/companion" },
    ]),
    ["renderer", "notch/companion"]
  );
  assert.deepEqual(
    processRoles({ pid: 13, command: "electron --type=gpu-process" }, 10),
    ["GPU"]
  );
});
