import { SUPPORTED_LANGUAGES } from "@abacus-ai/contract/contract";
import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";
const flat = (tree: object, prefix = ""): string[] =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [prefix + key] : flat(value, prefix + key + ".")
  );
it("R7-T26 every shipped locale has the final key set", () => {
  const keys = flat(enUS).sort();
  const locales = import.meta.glob<{ default: object }>(
    "../../locales/*.json",
    { eager: true }
  );
  expect(Object.keys(locales)).toHaveLength(SUPPORTED_LANGUAGES.length);
  const base = new Set(keys);
  for (const [file, locale] of Object.entries(locales)) {
    // A plural stem may carry the extra CLDR forms its language uses (Polish
    // `_few` / `_many`); every other key matches en-US exactly.
    const tag = file.replace(/^.*\/|\.json$/g, "");
    const forms = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
    const own = flat(locale.default).filter((key) => {
      const plural = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
      return (
        base.has(key) ||
        plural == null ||
        !base.has(`${plural[1]}_other`) ||
        !forms.includes(plural[2] as Intl.LDMLPluralRule)
      );
    });
    expect(own.sort(), file).toEqual(keys);
  }
});
