import { expect, it } from "vitest";

import { readSourceFiles } from "#renderer/test-support/source-files";

import spec from "../../../../../docs/rewrite/specs/06-onboarding-tour-notch.md?raw";
import { PHASE6_NOTCH_PARITY } from "../notch/parity";
import { PHASE6_ONBOARDING_PARITY } from "./parity";
const files = readSourceFiles(
  [
    "/apps/web/src/**/*.ts",
    "/apps/web/src/**/*.tsx",
    "/apps/desktop/src/main/**/*.ts",
  ],
  import.meta.dirname
);
it("R6-T40 every spec parity row has a status and a located consumer or explicit other-phase owner", () => {
  const ids = [...spec.matchAll(/^\| ((?:OB|FB|TR|NT)\d+) \|/gm)].map(
    (match) => match[1]
  );
  const rows = [...PHASE6_ONBOARDING_PARITY, ...PHASE6_NOTCH_PARITY];
  expect(rows.map((row) => row.id)).toEqual(ids);
  for (const row of rows) {
    expect(row.status).not.toBe("");
    if (!row.consumer.startsWith("retired: "))
      expect(files[`/${row.consumer.split("#")[0]}`], row.id).toBeDefined();
  }
});
