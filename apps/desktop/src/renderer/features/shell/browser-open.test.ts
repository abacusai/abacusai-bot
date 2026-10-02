import { expect, it, vi } from "vitest";

import { registerBrowserOpen, requestBrowserOpen } from "./browser-open";
it("hands the complete session URL request to the registered browser and unregisters only its owner", () => {
  const first = vi.fn(),
    next = vi.fn();
  const release = registerBrowserOpen(first);
  const releaseNext = registerBrowserOpen(next);
  release();
  requestBrowserOpen({ sessionId: "s", url: "https://example.test/report" });
  expect(next).toHaveBeenCalledWith({
    sessionId: "s",
    url: "https://example.test/report",
  });
  expect(first).not.toHaveBeenCalled();
  releaseNext();
  requestBrowserOpen({ sessionId: "s", url: "https://example.test/other" });
  expect(next).toHaveBeenCalledTimes(1);
});
