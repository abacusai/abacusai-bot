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
  manualInstall: null,
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
  it("a manual .deb install outranks downloaded, clicked and an install error", () => {
    const manualInstall = {
      command: "sudo apt install /tmp/b.deb",
      packagePath: "/tmp/b.deb",
    };
    expect(
      updatePhase(
        {
          ...idle,
          downloaded: true,
          error: "fail",
          failedPhase: "install",
          manualInstall,
        },
        true
      )
    ).toBe("manualInstall");
    // An install in flight still reads as installing.
    expect(
      updatePhase({
        ...idle,
        downloaded: true,
        installing: true,
        manualInstall,
      })
    ).toBe("installing");
  });
  it("a restart queued behind a running task reads as queued, then installing", () => {
    const queued = { ...idle, downloaded: true, restartQueued: true };
    expect(updatePhase(queued)).toBe("queued");
    expect(updatePhase(queued, true)).toBe("queued");
    expect(updatePhase({ ...queued, installing: true })).toBe("installing");
    // A shell without the field: a click still reads as installing.
    expect(updatePhase({ ...idle, downloaded: true }, true)).toBe("installing");
  });
});
