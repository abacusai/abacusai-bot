import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { consumers, flatten, sourceFiles } from "./i18n-consumers.mjs";
test("consumer set includes literals, data keys, props, plural stems and template prefixes", () => {
  const keys = [
    "plain",
    "data.key",
    "prop.key",
    "items_one",
    "items_other",
    "family.a",
    "family.b",
    "unused",
  ];
  const source = `t('plain'); const row = {titleKey:'data.key'}; const el = <Trans i18nKey="prop.key"/>; t('items',{count:2}); t(\`family.\${value}\`);`;
  assert.deepEqual(
    [...consumers(keys, { "fixture.tsx": source })].sort(),
    keys.filter((k) => k !== "unused").sort()
  );
  assert.deepEqual(
    [
      ...consumers(keys, { "fixture.tsx": source }, [
        { prefix: "family.", values: ["a"] },
      ]),
    ].sort(),
    keys.filter((k) => k !== "unused" && k !== "family.b").sort()
  );
});
test("empty-prefix templates require finite declaration", () =>
  assert.throws(
    () => consumers(["unused"], { "fixture.ts": "t(`${key}`)" }),
    /Unbounded/
  ));
test("R7-T26 every remaining leaf belongs to the final consumer set", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const keys = flatten(
    JSON.parse(
      fs.readFileSync(path.join(root, "src/renderer/locales/en-US.json"))
    )
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/i18n-dynamic-keys.json"))
  );
  const sources = sourceFiles(path.join(root, "src/renderer"));
  for (const locale of fs.readdirSync(
    path.join(root, "src/renderer/locales")
  )) {
    if (!locale.endsWith(".json")) continue;
    const localeKeys = flatten(
      JSON.parse(
        fs.readFileSync(path.join(root, "src/renderer/locales", locale))
      )
    );
    assert.doesNotThrow(
      () => consumers(localeKeys, sources, manifest, keys),
      locale
    );
  }
  const retained = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/i18n-retained-keys.json"))
  ).keys;
  for (const key of retained) assert.ok(keys.includes(key), key);
  const used = consumers(keys, sources, manifest);
  assert.deepEqual(
    keys.filter((key) => !used.has(key) && !retained.includes(key)),
    []
  );
});
test("rejects missing declared dynamic keys and incomplete plural families in every locale", () => {
  const sources = {
    "fixture.ts": "t(`family.${value}`); t('items', {count: 2});",
  };
  const dynamic = [{ prefix: "family.", values: ["a", "deleted"] }];
  assert.throws(
    () => consumers(["family.a", "items_one", "items_other"], sources, dynamic),
    /family.deleted/
  );
  assert.throws(() => consumers(["items_one"], sources), /items_other/);
  const reference = ["family.a", "family.deleted", "items_one", "items_other"];
  assert.throws(
    () =>
      consumers(
        ["family.a", "family.deleted", "items_other"],
        sources,
        dynamic,
        reference
      ),
    /items_one/
  );
});
test("a declared plural member requires its complete family", () => {
  assert.throws(
    () =>
      consumers(["family.count_one"], {}, [
        { prefix: "family.", values: ["count_one"] },
      ]),
    /family.count_other/
  );
});
