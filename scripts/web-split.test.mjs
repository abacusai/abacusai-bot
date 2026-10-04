import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
const web = "apps/web";
test("web configuration canaries still point at the renderer tree", () => {
  const components = JSON.parse(readFileSync(`${web}/components.json`));
  assert.equal(components.tailwind.css, "src/styles/app.css");
  assert.ok(existsSync(`${web}/${components.tailwind.css}`));
  const imports = JSON.parse(readFileSync(`${web}/package.json`)).imports;
  assert.ok(imports["#renderer/*"].includes("./src/*/index.tsx"));
  assert.ok(existsSync(`${web}/src/components/bot-avatar/index.tsx`));
  assert.ok(existsSync(`${web}/src/routes/_bare/[__ui].tsx`));
  assert.ok(existsSync("packages/contract/src/contract/index.ts"));
});
test("oxlint rejects static native imports from a shared module", () => {
  const file = `${web}/src/__web_split_lint_canary.ts`;
  try {
    writeFileSync(
      file,
      'import { nativePresenterFor } from "#renderer/features/shell/native-presenter"; console.log(nativePresenterFor);\n'
    );
    const result = spawnSync("pnpm", ["exec", "oxlint", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /no-restricted-imports/);
  } finally {
    rmSync(file, { force: true });
  }
});
