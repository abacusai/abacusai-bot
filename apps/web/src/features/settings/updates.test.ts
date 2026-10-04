import type { UpdateStatus } from "@abacus-ai/contract/update";
import { describe, it, expect } from "vitest";

import { updatePhase } from "./updates";
const idle = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
} as UpdateStatus;
describe("update recovery", () => {
  it("R5-T27 install failure outranks downloaded and clicked", () => {
    expect(
      updatePhase(
        { ...idle, downloaded: true, error: "fail", failedPhase: "install" },
        true
      )
    ).toBe("installFailed");
  });
  it("R5-T27 uses typed failure phase and stalls stand down", () => {
    expect(
      updatePhase({ ...idle, error: "ambiguous", failedPhase: "download" })
    ).toBe("downloadFailed");
    expect(
      updatePhase({ ...idle, error: "ambiguous", failedPhase: "check" })
    ).toBe("checkFailed");
    expect(
      updatePhase({
        ...idle,
        downloaded: true,
        criticalUpdate: true,
        installStalled: true,
      })
    ).toBe("stalled");
  });
});
