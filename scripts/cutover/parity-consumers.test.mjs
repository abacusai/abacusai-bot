import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { resolveConsumer } from "./parity-consumers.mjs";
import { specifiers } from "./parsed-source.mjs";
const desktop = path.resolve("apps/desktop");
test("parsed consumer rejects legacy paths, missing symbols and empty retirements", () => {
  resolveConsumer(
    "apps/web/src/features/settings/companion.tsx#CompanionSettings",
    desktop
  );
  for (const value of [
    "",
    "apps/web/src/app.tsx#App",
    "apps/web/src/features/settings/companion.tsx#Missing",
    "retired: ",
  ])
    assert.throws(() => resolveConsumer(value, desktop));
});
test("specifier parser sees imports, re-exports, require, dynamic import and import types without matching comments", () => {
  assert.deepEqual(
    specifiers(
      "fixture.ts",
      `import x from 'a';export {x} from 'b';export * from 'c';require('d');import('e');type T=import('f').T;import q=require('g');// import 'comment'
 const text="require('string')";`
    ),
    ["a", "b", "c", "d", "e", "f", "g"]
  );
});
