import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { accountStub } from "./account-stub.mjs";

test("the local stub identifies only its synthetic key and never forwards other routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-stub-test-"));
  const stub = await accountStub(root);
  try {
    assert.equal((await fetch(`${stub.url}/v1/account`)).status, 404);
    const response = await fetch(`${stub.url}/v1/account`, {
      headers: { authorization: "Bearer synthetic-cutover-key" },
    });
    assert.equal((await response.json()).email, "fixture@example.invalid");
    assert.equal((await fetch(`${stub.url}/updates/latest.yml`)).status, 404);
    assert.equal(stub.requests.length, 3);
  } finally {
    await stub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
