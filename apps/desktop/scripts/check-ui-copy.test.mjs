import assert from "node:assert/strict";
import { test } from "node:test";

import { literalTranslationKeys, validateCopy } from "./check-ui-copy.mjs";

test("rejects missing, object-valued, empty and placeholder translations", () => {
  const errors = validateCopy(
    { group: { label: "Tools" }, empty: "", copy: "Tools description" },
    ["missing", "group", "empty"]
  );
  assert.ok(errors.includes("Missing key: missing"));
  assert.ok(errors.includes("Non-string key: group"));
  assert.ok(errors.includes("Non-string key: empty"));
  assert.ok(errors.includes("Placeholder copy: copy"));
});
test("resolves flat dotted keys and plural forms using the runtime rules", () => {
  assert.deepEqual(
    validateCopy(
      {
        section: { "flat.label": "Ready" },
        items_one: "One item",
        items_other: "{{count}} items",
      },
      ["section.flat.label", "items"]
    ),
    []
  );
});
test("checks both branches of translated conditional copy", () => {
  assert.deepEqual(
    [
      ...literalTranslationKeys({
        "fixture.tsx": 't(flag ? "yes" : "no"); t(`plain`);',
      }),
    ],
    ["yes", "no", "plain"]
  );
});

test("catalog templates must select a string leaf", () => {
  const resource = { capabilities: { toolsets: { file: { label: "Files" } } } };
  const broken = literalTranslationKeys(
    { "fixture.tsx": "t(`capabilities.toolsets.${id}`)" },
    resource
  );
  assert.deepEqual(validateCopy(resource, broken), [
    "Non-string key: capabilities.toolsets.file",
  ]);
  const fixed = literalTranslationKeys(
    { "fixture.tsx": "t(`capabilities.toolsets.${id}.label`)" },
    resource
  );
  assert.deepEqual(validateCopy(resource, fixed), []);
});
