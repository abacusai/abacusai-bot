import { expect, it } from "vitest";

import { externalOpenSince, markExternalOpen } from "./external-open";

it("tells the return landing a link or notice opened something since the window showed", () => {
  markExternalOpen(1_000);
  expect(externalOpenSince(1_000)).toBe(true);
  expect(externalOpenSince(1_001)).toBe(false);
});
