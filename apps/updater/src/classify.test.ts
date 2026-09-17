import assert from "node:assert/strict";

import { test } from "vitest";

import { classify } from "./classify.ts";

void test("renderer and agent changes are experience releases", () => {
  assert.equal(classify(["apps/desktop/src/renderer/app.tsx"]), "experience");
  assert.equal(classify(["packages/agent/src/session.ts"]), "experience");
  assert.equal(classify(["apps/desktop/index.html"]), "experience");
});

void test("unknown files fail toward the signed foundation release", () => {
  assert.equal(classify(["apps/desktop/src/main/index.ts"]), "foundation");
  assert.equal(classify(["apps/desktop/src/preload/index.ts"]), "foundation");
  assert.equal(classify(["packages/boundless/src/index.ts"]), "foundation");
  assert.equal(
    classify(["apps/desktop/src/renderer/x.ts", "package.json"]),
    "foundation"
  );
});

void test("dependency changes are always foundation releases", () => {
  assert.equal(classify(["packages/agent/package.json"]), "foundation");
  assert.equal(classify(["pnpm-lock.yaml"]), "foundation");
  assert.equal(classify(["pnpm-workspace.yaml"]), "foundation");
  assert.equal(
    classify(["patches/ghostty-web@0.4.0.patch", "apps/desktop/src/renderer/x.ts"]),
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
  assert.equal(
    classify(["apps\\desktop\\src\\renderer\\app.tsx"]),
    "experience"
  );
  assert.equal(classify(["./packages/agent/src/session.ts"]), "experience");
});
