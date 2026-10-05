import assert from "node:assert/strict";
import { test } from "node:test";

import { registryContent } from "./registry-content.mjs";

test("desktop replay tolerates only the redundant client directive", () => {
  const source = 'import { Dialog } from "dialog";\n';
  for (const directive of ['"use client";\n\n', "'use client';\r\n\r\n"]) {
    assert.equal(registryContent(directive + source, false), source);
  }
  assert.notEqual(registryContent('"use client";\n\n' + source, true), source);
});

test("desktop replay still detects source, imports and other directive changes", () => {
  const source = "export const value = 1;\n";
  for (const changed of [
    "export const value = 2;\n",
    '"use server";\n\n' + source,
    'import "other";\n' + source,
  ]) {
    assert.notEqual(
      registryContent(changed, false),
      registryContent(source, false)
    );
  }
});
