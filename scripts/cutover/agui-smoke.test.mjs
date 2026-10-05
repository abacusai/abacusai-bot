import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("CI AG-UI smoke requires executed tests from the complete renamed spawn suite", async () => {
  const ci = fs.readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  assert.ok(ci.includes("node scripts/cutover/agui-smoke.mjs"));
  assert.ok(!ci.includes("--testNamePattern 'same bytes on fd 3'"));
  const { requireExecutedTests } = await import("./agui-smoke.mjs");
  assert.throws(
    () =>
      requireExecutedTests({
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 3,
      }),
    /executed/
  );
  assert.throws(
    () =>
      requireExecutedTests({
        numPassedTests: 2,
        numFailedTests: 1,
        numPendingTests: 0,
      }),
    /failed/
  );
  assert.throws(
    () =>
      requireExecutedTests({
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 1,
      }),
    /skipped/
  );
  assert.doesNotThrow(() =>
    requireExecutedTests({
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
    })
  );
});
