import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";

import { DYNAMIC_KEYS } from "./dynamic-keys";

const flat = (tree: object, prefix = ""): string[] =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [`${prefix}${key}`]
      : flat(value, `${prefix}${key}.`)
  );
const keys = flat(enUS);
const sources = import.meta.glob<string>(
  [
    "/src/renderer-next/**/*.{ts,tsx}",
    "!/src/renderer-next/**/*.test.*",
    "!/src/renderer-next/ui/**",
    "!/src/renderer-next/**/*.d.ts",
    "!/src/renderer-next/lib/i18n/dynamic-keys.ts",
  ],
  { query: "?raw", import: "default", eager: true }
);
const readJson = (raw: Record<string, string>) =>
  JSON.parse(Object.values(raw)[0]!);
const keymap = readJson(
  import.meta.glob<string>("../../../../scripts/locale-keymap.json", {
    query: "?raw",
    import: "default",
    eager: true,
  })
) as Record<string, string>;
const retired = readJson(
  import.meta.glob<string>("../../../../scripts/locale-retired.json", {
    query: "?raw",
    import: "default",
    eager: true,
  })
) as Record<string, { reason: string }>;
const match = (key: string, pattern: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+")}$`
  ).test(key);
it("R5-T35 every locale leaf is consumed, mapped or explicitly retained with a reason", () => {
  const literals = new Set(
    Object.values(sources).flatMap((source) =>
      [...source.matchAll(/["']([\w.-]+)["']/g)].map((match) => match[1]!)
    )
  );
  const mapped = new Set(
    Object.entries(keymap)
      .filter(([key]) => !key.startsWith("$"))
      .map(([, value]) => value)
  );
  const missing = keys.filter(
    (key) =>
      !literals.has(key) &&
      !literals.has(key.replace(/_(zero|one|two|few|many|other)$/, "")) &&
      !mapped.has(key) &&
      !DYNAMIC_KEYS.some((row) => match(key, row.pattern)) &&
      !retired[key]?.reason.trim()
  );
  expect(missing).toEqual([]);
  for (const row of DYNAMIC_KEYS) {
    expect(
      keys.some((key) => match(key, row.pattern)),
      row.pattern
    ).toBe(true);
    for (const source of row.sources)
      expect(sources[`/src/renderer-next/${source}`], source).toBeDefined();
  }
  for (const [key, row] of Object.entries(retired)) {
    expect(keys, key).toContain(key);
    expect(row.reason.length, key).toBeGreaterThan(20);
  }
});
