import { describe, expect, it } from "vitest";

import { parseProbe, SandboxProbeService } from "./sandbox-probe-service";

describe("the sandbox probe", () => {
  it("reads the agent's verdict from the last line, past any runtime chatter", () => {
    expect(
      parseProbe(
        'some warning\n{"active":false,"reason":"bubblewrap or socat is not installed"}\n'
      )
    ).toEqual({
      available: false,
      reason: "bubblewrap or socat is not installed",
    });
    expect(parseProbe('{"active":true,"reason":null}')).toEqual({
      available: true,
      reason: null,
    });
  });

  it("rejects output that is not a verdict rather than inventing one", () => {
    expect(() => parseProbe("")).toThrow();
    expect(() => parseProbe('{"ok":true}')).toThrow();
  });

  it("answers an older Windows without spawning anything", async () => {
    let spawned = 0;
    const service = new SandboxProbeService(
      () => {
        spawned += 1;
        throw new Error("must not resolve the agent");
      },
      "win32",
      "10.0.22631"
    );

    await expect(service.support()).resolves.toEqual({
      available: false,
      reason: "needs Windows 11 24H2 or newer",
    });
    expect(spawned).toBe(0);
  });

  it("turns a probe that cannot run into an unavailable sandbox, once", async () => {
    let resolved = 0;
    const service = new SandboxProbeService(
      () => {
        resolved += 1;
        throw new Error("no agent here");
      },
      "darwin",
      "24.0.0"
    );

    const first = await service.support();
    expect(first.available).toBe(false);
    expect(first.reason).toContain("no agent here");
    await service.support();
    expect(resolved).toBe(1);
  });
});
