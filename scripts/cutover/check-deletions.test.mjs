import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { resolveLocal } from "./check-deletions.mjs";
test("migrated shared code resolves and a deleted legacy shim fails", () => {
  const desktop = path.resolve("apps/desktop");
  assert.ok(
    resolveLocal(
      "@abacus-ai/contract/transcript/v1-types",
      path.join(desktop, "src/main/index.ts"),
      desktop
    )
  );
  assert.throws(() =>
    resolveLocal(
      "#renderer/conversation/agent-types",
      path.join(desktop, "src/main/index.ts"),
      desktop
    )
  );
});
