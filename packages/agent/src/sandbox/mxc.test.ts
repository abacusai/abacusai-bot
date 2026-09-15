/**
 * The Windows backend's pure parts. The runner itself is exercised only on a
 * Windows build that can make a process container, which no other platform
 * can stand in for.
 */
import { describe, expect, it } from "vitest";

import {
  buildConfig,
  buildSupported,
  deniedPaths,
  driveRoots,
  runProbe,
} from "./mxc.js";
import type { SandboxPolicy } from "./policy.js";

const env = {
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  SystemDrive: "C:",
  HOMEDRIVE: "C:",
};

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    mode: "workspace-write",
    enforcement: "auto",
    workspaceRoot: "C:\\work\\repo",
    writableTemp: ["C:\\Users\\dev\\AppData\\Local\\Temp"],
    secrets: { denied: [], allowed: [], promptable: [] },
    network: { kind: "open" },
    ...overrides,
  };
}

function decode(argv: string[]): Record<string, unknown> {
  const index = argv.indexOf("--config-base64");
  expect(index).toBeGreaterThan(-1);

  return JSON.parse(Buffer.from(argv[index + 1]!, "base64").toString("utf8"));
}

describe("the Windows build gate", () => {
  it("accepts 24H2 and later, and nothing older", () => {
    expect(buildSupported("10.0.26100")).toBe(true);
    expect(buildSupported("10.0.26200")).toBe(true);
    expect(buildSupported("10.0.22631")).toBe(false);
    expect(buildSupported("10.0.19045")).toBe(false);
  });

  it("treats an unreadable release as unsupported", () => {
    expect(buildSupported("")).toBe(false);
    expect(buildSupported("25.5.0")).toBe(false);
  });
});

describe("the config", () => {
  it("writes the workspace and temp, reads every drive, denies the stores", () => {
    const config = buildConfig(
      policy({
        secrets: {
          denied: ["C:\\Users\\dev\\.netrc"],
          allowed: [],
          promptable: [],
        },
      }),
      "npm test",
      "C:\\work\\repo",
      env
    );
    expect(config.containment).toBe("processcontainer");
    expect(config.filesystem).toEqual({
      readonlyPaths: ["C:\\"],
      readwritePaths: [
        "C:\\work\\repo",
        "C:\\Users\\dev\\AppData\\Local\\Temp",
      ],
      deniedPaths: ["C:\\Users\\dev\\.netrc"],
    });
  });

  it("keeps the workspace read-only in read-only mode", () => {
    const config = buildConfig(
      policy({ mode: "read-only" }),
      "dir",
      "C:\\work\\repo",
      env
    ) as {
      filesystem: { readwritePaths: string[] };
    };
    expect(config.filesystem.readwritePaths).toEqual([
      "C:\\Users\\dev\\AppData\\Local\\Temp",
    ]);
  });

  it("runs the command through cmd.exe the way the unconfined path does", () => {
    const config = buildConfig(
      policy(),
      'echo "hi"',
      "C:\\work\\repo",
      env
    ) as {
      process: { commandLine: string; cwd: string };
    };
    expect(config.process.commandLine).toBe(
      'C:\\Windows\\System32\\cmd.exe /d /s /c "echo "hi""'
    );
    expect(config.process.cwd).toBe("C:\\work\\repo");
  });

  it("leaves the network open, like the other platforms", () => {
    const config = buildConfig(policy(), "dir", "C:\\work\\repo", env) as {
      network: { egress: { default: string } };
    };
    expect(config.network.egress.default).toBe("allow");
  });

  it("reads from a workspace on another drive too", () => {
    expect(driveRoots(["D:\\code\\app", "C:\\x"], env)).toEqual([
      "C:\\",
      "D:\\",
    ]);
  });
});

describe("denied paths", () => {
  const list = (dir: string): string[] =>
    dir === "C:\\Users\\dev\\.ssh"
      ? ["config", "id_rsa", "id_rsa.pub", "known_hosts"]
      : [];

  it("denies a store whole when nothing inside it is read back", () => {
    expect(
      deniedPaths({ denied: ["C:\\Users\\dev\\.netrc"], allowed: [] }, list)
    ).toEqual(["C:\\Users\\dev\\.netrc"]);
  });

  it("denies the hidden children one by one when some are read back", () => {
    // deniedPaths beat every allow in the runner, so the directory cannot be
    // denied and its config allowed back on top.
    expect(
      deniedPaths(
        {
          denied: ["C:\\Users\\dev\\.ssh"],
          allowed: [
            "C:\\Users\\dev\\.ssh\\config",
            "C:\\Users\\dev\\.ssh\\id_rsa.pub",
            "C:\\Users\\dev\\.ssh\\known_hosts",
          ],
        },
        list
      )
    ).toEqual(["C:\\Users\\dev\\.ssh\\id_rsa"]);
  });
});

describe("the probe", () => {
  const runner = "C:\\app\\vendor\\mxc\\wxc-exec.exe";
  const writable = "C:\\Temp\\probe";
  const target = "C:\\Temp\\canary\\canary";

  it("passes only when the control succeeds and the canary is refused", () => {
    const calls: string[] = [];
    const exec = (argv: string[]): number => {
      const command = (decode(argv.slice(1)).process as { commandLine: string })
        .commandLine;
      calls.push(command);

      return command.includes("exit 0") ? 0 : 1;
    };
    expect(runProbe(runner, writable, target, exec, env)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(target);
  });

  it("fails when the canary write goes through", () => {
    expect(runProbe(runner, writable, target, () => 0, env)).toBe(false);
  });

  it("fails when no container can be made at all", () => {
    expect(runProbe(runner, writable, target, () => 1, env)).toBe(false);
    expect(runProbe(runner, writable, target, () => null, env)).toBe(false);
  });

  it("gives no verdict on a timeout", () => {
    expect(runProbe(runner, writable, target, () => "timeout", env)).toBeNull();
  });

  it("confines the probe's own writes to its scratch directory", () => {
    let seen: { readwritePaths: string[]; readonlyPaths: string[] } | undefined;
    runProbe(
      runner,
      writable,
      target,
      (argv) => {
        seen = decode(argv.slice(1)).filesystem as typeof seen;

        return 0;
      },
      env
    );
    expect(seen?.readwritePaths).toEqual([writable]);
    expect(seen?.readonlyPaths).toEqual(["C:\\"]);
  });
});
