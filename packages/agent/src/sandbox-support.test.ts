import { describe, expect, it } from "vitest";

import { sandboxBackendFor } from "./sandbox-support.js";

describe("sandbox platform support", () => {
  it.each([
    ["10.0.17763", "x64", null],
    ["10.0.18362", "x64", "sandy"],
    ["10.0.26100", "x64", "sandy"],
    ["10.0.19045", "arm64", null],
    ["10.0.22000", "arm64", "sandy"],
    ["10.0.26100", "ia32", null],
    ["invalid", "x64", null],
  ])("selects Windows %s on %s", (release, arch, expected) => {
    expect(sandboxBackendFor("win32", release!, arch!)).toBe(expected);
  });

  it("retains the macOS and Linux runtime", () => {
    expect(sandboxBackendFor("darwin", "24.0.0")).toBe("sandbox-runtime");
    expect(sandboxBackendFor("linux", "6.8.0")).toBe("sandbox-runtime");
  });
});
