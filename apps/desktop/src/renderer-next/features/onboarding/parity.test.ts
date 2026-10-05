import { expect, it } from "vitest";

import spec from "../../../../../../docs/rewrite/specs/06-onboarding-tour-notch.md?raw";
import { PHASE6_NOTCH_PARITY } from "../notch/parity";
import { PHASE6_ONBOARDING_PARITY } from "./parity";
const files = import.meta.glob<string>(
  [
    "/src/renderer-next/**/*.ts",
    "/src/renderer-next/**/*.tsx",
    "/src/main/**/*.ts",
  ],
  { query: "?raw", import: "default", eager: true }
);
it("R6-T40 every spec parity row has a status and a located consumer or explicit other-phase owner", () => {
  const ids = [...spec.matchAll(/^\| ((?:OB|FB|TR|NT)\d+) \|/gm)].map(
    (match) => match[1]
  );
  const rows = [...PHASE6_ONBOARDING_PARITY, ...PHASE6_NOTCH_PARITY];
  expect(rows.map((row) => row.id)).toEqual(ids);
  for (const row of rows) {
    expect(row.status).not.toBe("");
    if (row.consumer)
      expect(
        files[
          row.consumer.startsWith("../main/")
            ? `/src/${row.consumer.slice(3)}`
            : `/src/renderer-next/${row.consumer}`
        ],
        row.id
      ).toBeDefined();
    else expect(row.owner).toBe("other-phase");
  }
});
