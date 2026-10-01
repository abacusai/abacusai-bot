import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";
const flat = (tree: object, prefix = ""): string[] =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [prefix + key] : flat(value, prefix + key + ".")
  );
it("R7-T26 all eleven locales have the final key set", () => {
  const keys = flat(enUS).sort();
  const locales = import.meta.glob<{ default: object }>(
    "../../locales/*.json",
    { eager: true }
  );
  expect(Object.keys(locales)).toHaveLength(11);
  for (const [file, locale] of Object.entries(locales))
    expect(flat(locale.default).sort(), file).toEqual(keys);
});
