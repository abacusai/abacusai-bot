import assert from "node:assert/strict";

import { test } from "vitest";

import { classify } from "./classify.ts";

void test("renderer and agent changes are experience releases", () => {
  assert.equal(classify(["apps/web/src/app.tsx"]), "experience");
  assert.equal(classify(["packages/agent/src/session.ts"]), "experience");
  assert.equal(classify(["apps/web/index.html"]), "experience");
  for (const file of ["index.html", "notch.html", "src/main.tsx"])
    assert.equal(classify([`apps/web/${file}`]), "experience");
});

void test("unknown files fail toward the signed foundation release", () => {
  assert.equal(classify(["apps/desktop/src/main/index.ts"]), "foundation");
  assert.equal(classify(["apps/desktop/src/preload/index.ts"]), "foundation");
  assert.equal(classify(["packages/boundless/src/index.ts"]), "foundation");
  assert.equal(classify(["apps/web/src/x.ts", "package.json"]), "foundation");
});

void test("dependency changes are always foundation releases", () => {
  assert.equal(classify(["packages/agent/package.json"]), "foundation");
  assert.equal(classify(["pnpm-lock.yaml"]), "foundation");
  assert.equal(classify(["pnpm-workspace.yaml"]), "foundation");
  assert.equal(
    classify(["patches/ghostty-web@0.4.0.patch", "apps/web/src/x.ts"]),
    "foundation"
  );
});

void test("ignored files produce no release", () => {
  assert.equal(
    classify([
      "README.md",
      "docs/x.md",
      ".github/y.yml",
      "apps/updater/src/x.ts",
    ]),
    "none"
  );
  assert.equal(classify([]), "none");
});

void test("windows separators and leading dot segments are normalized", () => {
  assert.equal(classify(["apps\\web\\src\\app.tsx"]), "experience");
  assert.equal(classify(["./packages/agent/src/session.ts"]), "experience");
});

void test("ignores host and browser-only connection changes while contract changes require foundation", () => {
  assert.equal(
    classify([
      "apps/host/src/index.ts",
      "apps/web/src/features/shell/lease.ts",
      "apps/web/src/features/shell/connect/index.tsx",
      "apps/web/vite.config.ts",
    ]),
    "none"
  );
  assert.equal(
    classify(["packages/contract/src/contract/system.ts"]),
    "foundation"
  );
});
