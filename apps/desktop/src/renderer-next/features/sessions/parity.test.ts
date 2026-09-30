import { expect, it } from "vitest";

import { SESSION_PARITY } from "./parity";
const targets = import.meta.glob("/src/renderer-next/**/*.{ts,tsx}");
it("R4-T31 inventories all 111 spec rows with an existing target and an explicit status", () => {
  expect(SESSION_PARITY.map((row) => row.id)).toEqual(
    Array.from({ length: 111 }, (_, i) => `S${i + 1}`)
  );
  for (const row of SESSION_PARITY) {
    expect(Object.keys(targets)).toContain(`/src/renderer-next/${row.target}`);
    expect(["partial", "retired", "deferred"]).toContain(row.implementation);
  }
});
