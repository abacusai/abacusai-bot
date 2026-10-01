import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSource, removed } from "./check-removed-deps.mjs";
for (const name of removed)
  test(`detects every import form of ${name}`, () => {
    for (const code of [
      `import x from '${name}'`,
      `import '${name}'`,
      `import('${name}/subpath')`,
      `export {x} from '${name}'`,
      `const x=require('${name}')`,
      `import type {X} from '${name}'`,
    ])
      assert.throws(
        () => checkSource("fixture.ts", code),
        /Removed dependency/
      );
    for (const directive of ["import", "source", "plugin"])
      assert.throws(
        () => checkSource("fixture.css", `@${directive} '${name}';`),
        /Removed dependency/
      );
  });
test("permits local paths and motion", () =>
  checkSource(
    "fixture.ts",
    `import x from 'motion/react'; import y from './zustand';`
  ));
