import { expect, it, vi } from "vitest";

import { RefusedTargets } from "./refused-targets";
it.each([
  "foundation version",
  "foundation API",
  "protocol",
  "build provenance",
])("R7-T3: memoizes a %s refusal for this process only", async (reason) => {
  const memo = new RefusedTargets();
  const verify = vi.fn(async () => {
    throw new Error(reason);
  });
  await expect(memo.verify("hash", verify)).rejects.toThrow(reason);
  expect(memo.has("hash")).toBe(true);
  expect(memo.has("changed-hash")).toBe(false);
  expect(new RefusedTargets().has("hash")).toBe(false);
});
it("transient extraction and IO errors are retried", async () => {
  const memo = new RefusedTargets();
  await expect(
    memo.verify("hash", async () => {
      throw new Error("EIO");
    })
  ).rejects.toThrow();
  expect(memo.has("hash")).toBe(false);
});
