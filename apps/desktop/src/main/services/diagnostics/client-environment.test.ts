import { describe, expect, it } from "vitest";

import {
  collectClientEnvironment,
  parseOsRelease,
  type EnvironmentProbes,
} from "./client-environment";

const probes = (overrides: EnvironmentProbes = {}): EnvironmentProbes => ({
  platform: "darwin",
  arch: "arm64",
  release: () => "25.6.0",
  cpuModel: () => "Apple M4 Pro",
  systemVersion: () => "26.0.1",
  osRelease: () => null,
  locale: () => "en-US",
  env: {},
  ...overrides,
});

describe("the machine an upload came from", () => {
  it("reports the version a user recognizes, not just the kernel", () => {
    const env = collectClientEnvironment(probes());

    expect(env).toMatchObject({
      os_name: "macOS",
      os_version: "26.0.1",
      os_release: "25.6.0",
      arch: "arm64",
      arm64_translated: false,
      locale: "en-US",
    });
  });

  it("falls back to the kernel release when Electron is not there to ask", () => {
    expect(
      collectClientEnvironment(probes({ systemVersion: () => null })).os_version
    ).toBe("25.6.0");
  });

  it("names the distro on Linux", () => {
    const env = collectClientEnvironment(
      probes({
        platform: "linux",
        systemVersion: () => null,
        osRelease: () => 'NAME="Ubuntu"\nVERSION_ID="24.04"\n',
      })
    );

    expect(env.os_name).toBe("Ubuntu");
    expect(env.os_version).toBe("24.04");
  });

  it("marks an x64 build on an arm64 machine as translated", () => {
    expect(
      collectClientEnvironment(probes({ arch: "x64" })).arm64_translated
    ).toBe(true);
    expect(
      collectClientEnvironment(
        probes({
          platform: "win32",
          arch: "x64",
          env: { PROCESSOR_ARCHITEW6432: "ARM64" },
        })
      ).arm64_translated
    ).toBe(true);
  });

  it("survives a probe that throws", () => {
    const env = collectClientEnvironment(
      probes({
        release: () => {
          throw new Error("no release");
        },
        systemVersion: () => {
          throw new Error("no system version");
        },
      })
    );

    expect(env.os_release).toBe("unknown");
    expect(env.os_version).toBe("unknown");
  });

  it("reads quoted and unquoted os-release fields", () => {
    expect(parseOsRelease('ID=fedora\nVERSION_ID="41"\n# comment\n')).toEqual({
      ID: "fedora",
      VERSION_ID: "41",
    });
  });
});
