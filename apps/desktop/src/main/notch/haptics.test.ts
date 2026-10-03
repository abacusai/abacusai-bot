import { execFile } from "node:child_process";

import { afterEach, expect, it, vi } from "vitest";

import { Haptics } from "./haptics";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => ({ kill: vi.fn() })),
}));
afterEach(() => vi.clearAllMocks());
it("R6-T26 central lineage/step dedupe across callers", () => {
  const h = new Haptics();
  for (let document = 0; document < 3; document += 1)
    h.play("t:i:1:p:0", true, "darwin");
  h.play("t:i:1:p:1", true, "darwin");
  h.play("t:i:1:p:2", false, "darwin");
  h.play("other", true, "win32");
  expect(execFile).toHaveBeenCalledTimes(2);
  const child = vi.mocked(execFile).mock.results[0]?.value;
  h.dispose();
  expect(child.kill).toHaveBeenCalledOnce();
});
