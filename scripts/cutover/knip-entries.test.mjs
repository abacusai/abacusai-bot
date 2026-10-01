import assert from "node:assert/strict";
import { test } from "node:test";

import { checkEntries } from "./knip-entries.mjs";
test("script entries reject omitted executables and helper entries", () => {
  assert.doesNotThrow(() =>
    checkEntries(["src/main/index.ts", "scripts/run.mjs"], ["scripts/run.mjs"])
  );
  assert.throws(() => checkEntries([], ["scripts/run.mjs"]));
  assert.throws(() =>
    checkEntries(
      ["scripts/run.mjs", "scripts/lib/helper.mjs"],
      ["scripts/run.mjs"]
    )
  );
});
