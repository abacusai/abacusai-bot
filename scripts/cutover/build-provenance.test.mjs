import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";

import { buildProvenance } from "../build-provenance.mjs";
const git = process.platform === "win32" ? "git" : "/usr/bin/git";
const head = execFileSync(git, ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
test("CI and release require a pinned checkout commit", () => {
  for (const env of [{ CI: "1" }, { ABACUS_RELEASE: "1" }])
    assert.throws(() => buildProvenance(env), /required/);
  assert.throws(
    () => buildProvenance({ ABACUS_BUILD_COMMIT: "b".repeat(40) }),
    /differs/
  );
  assert.equal(
    buildProvenance({ CI: "1", ABACUS_BUILD_COMMIT: head }).commit,
    head
  );
});
test("both renderer and agent cache keys include the pinned commit and build flags", () => {
  const config = JSON.parse(
    fs.readFileSync(new URL("../../turbo.json", import.meta.url))
  );
  for (const task of ["@abacus-ai/desktop#build", "@abacus-ai/agent#build"])
    assert.ok(config.tasks[task].env.includes("ABACUS_BUILD_COMMIT"));
});
