import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { executableScripts, checkEntries } from "./knip-entries.mjs";
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

test("workflow root scripts are not desktop executables", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "knip-entries-"));
  const workspace = path.join(repo, "apps/desktop");
  try {
    fs.mkdirSync(path.join(repo, ".github/workflows"), { recursive: true });
    fs.mkdirSync(path.join(repo, "scripts/cutover"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    fs.writeFileSync(path.join(workspace, "package.json"), "{}");
    fs.writeFileSync(path.join(workspace, "electron-builder.yml"), "");
    fs.writeFileSync(path.join(repo, "turbo.json"), "{}");
    fs.writeFileSync(path.join(repo, "scripts/cutover/agui-smoke.mjs"), "");
    fs.writeFileSync(path.join(workspace, "scripts/run.mjs"), "");
    fs.writeFileSync(
      path.join(repo, ".github/workflows/ci.yml"),
      "run: node scripts/cutover/agui-smoke.mjs\nrun: cd apps/desktop && node scripts/run.mjs\n"
    );
    assert.deepEqual(executableScripts(repo, workspace), ["scripts/run.mjs"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
