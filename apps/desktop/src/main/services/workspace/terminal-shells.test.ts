import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installPosixShell = vi.fn();

vi.mock("@abacus-ai/agent/posix-shell-install", () => ({
  installPosixShell: (...args: unknown[]) => installPosixShell(...args),
  posixShellEnv: (env: NodeJS.ProcessEnv, shell: { bin: string }) => ({
    ...env,
    PATH: `${shell.bin}${path.delimiter}${env.PATH ?? ""}`,
    BB_OVERRIDE_APPLETS: ";tar",
  }),
}));

vi.mock("#main/resources", () => ({
  agentVendorDir: () => vendor,
}));

const {
  effectiveTerminalShell,
  resetBusyboxForTesting,
  resolveTerminalShell,
  terminalShellStatuses,
} = await import("./terminal-shells");

let root: string;
let vendor: string;
let binDir: string;

/** An executable that exists, since resolution is a file check. */
const put = (name: string): string => {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, "");
  return file;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-shells-"));
  vendor = path.join(root, "vendor");
  binDir = path.join(root, "bin");
  fs.mkdirSync(vendor, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  installPosixShell.mockReset();
  resetBusyboxForTesting();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("terminal shells on Windows", () => {
  const windows = (extra: NodeJS.ProcessEnv = {}) => ({
    platform: "win32" as const,
    env: {
      PATH: binDir,
      PATHEXT: ".COM;.EXE;.CMD",
      ComSpec: put("cmd.exe"),
      ...extra,
    },
  });

  it("spawns the command prompt for cmd and PowerShell for powershell", () => {
    const systemRoot = path.join(root, "Windows");
    const shipped = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0"
    );
    fs.mkdirSync(shipped, { recursive: true });
    fs.writeFileSync(path.join(shipped, "powershell.exe"), "");
    const options = windows({ SystemRoot: systemRoot });

    expect(resolveTerminalShell("cmd", options)).toEqual({
      id: "cmd",
      file: options.env.ComSpec,
      args: [],
    });
    expect(resolveTerminalShell("powershell", options)).toEqual({
      id: "powershell",
      file: path.join(shipped, "powershell.exe"),
      args: ["-NoLogo"],
    });
  });

  it("reports pwsh missing when it is not installed", () => {
    expect(resolveTerminalShell("pwsh", windows()).id).toBe("system");
  });

  it.each([["pwsh.exe"], ["pwsh.EXE"]])(
    "finds %s through PATHEXT, whichever case the disk uses",
    (file) => {
      put(file);
      // Named without its extension, the way it is typed. PATHEXT is upper
      // case and the file usually is not, which only passes unnoticed on a
      // case-insensitive filesystem.
      const resolved = resolveTerminalShell("pwsh", windows());

      expect(resolved.id).toBe("pwsh");
      expect(resolved.args).toEqual(["-NoLogo"]);
      expect(resolved.file.toLowerCase()).toBe(
        path.join(binDir, "pwsh.exe").toLowerCase()
      );
    }
  );

  it("spawns the bundled busybox with its applets on PATH", () => {
    fs.writeFileSync(path.join(vendor, "busybox.exe"), "");
    const installed = {
      sh: path.join(root, "posix", "bin", "sh.exe"),
      bin: path.join(root, "posix", "bin"),
      overrideApplets: ";tar",
    };
    installPosixShell.mockReturnValue(installed);

    const resolved = resolveTerminalShell("busybox", windows());

    expect(resolved.id).toBe("busybox");
    expect(resolved.file).toBe(installed.sh);
    expect(resolved.env?.PATH?.startsWith(installed.bin)).toBe(true);
    expect(resolved.env?.BB_OVERRIDE_APPLETS).toBe(";tar");
  });

  it("installs busybox once however often a shell is resolved", () => {
    fs.writeFileSync(path.join(vendor, "busybox.exe"), "");
    installPosixShell.mockReturnValue({
      sh: "sh.exe",
      bin: "bin",
      overrideApplets: "",
    });

    resolveTerminalShell("busybox", windows());
    resolveTerminalShell("busybox", windows());

    expect(installPosixShell).toHaveBeenCalledOnce();
  });

  it("offers busybox only when the payload shipped", () => {
    const missing = terminalShellStatuses(windows());
    expect(missing.find((status) => status.id === "busybox")?.available).toBe(
      false
    );

    fs.writeFileSync(path.join(vendor, "busybox.exe"), "");
    const present = terminalShellStatuses(windows());
    expect(present.find((status) => status.id === "busybox")?.available).toBe(
      true
    );
    // Windows shells only; a bash row on Windows would never resolve.
    expect(present.map((status) => status.id)).toEqual([
      "system",
      "cmd",
      "powershell",
      "pwsh",
      "busybox",
    ]);
  });

  it("falls back to the command prompt when a stored shell stopped existing", () => {
    // busybox with no payload: nothing to spawn, and an empty panel is worse
    // than the wrong shell.
    expect(effectiveTerminalShell("busybox", windows())).toBe("system");
    expect(resolveTerminalShell("busybox", windows()).file).toBe(
      windows().env.ComSpec
    );
  });
});

describe("terminal shells on macOS and Linux", () => {
  const posix = (extra: NodeJS.ProcessEnv = {}) => ({
    platform: "darwin" as const,
    env: { PATH: binDir, SHELL: put("fish"), ...extra },
  });

  it("opens the login shell the machine says is the default", () => {
    const options = posix();

    expect(resolveTerminalShell("system", options)).toEqual({
      id: "system",
      file: options.env.SHELL,
      args: ["-l"],
    });
  });

  it("lists only the shells that are actually installed", () => {
    put("zsh");
    const statuses = terminalShellStatuses(posix());

    expect(statuses.find((status) => status.id === "zsh")).toEqual({
      id: "zsh",
      available: true,
      path: path.join(binDir, "zsh"),
    });
    expect(statuses.find((status) => status.id === "bash")?.available).toBe(
      false
    );
    // Not offered here at all: it is a Windows payload.
    expect(statuses.some((status) => status.id === "busybox")).toBe(false);
  });

  it("refuses a Windows id on a Unix machine", () => {
    expect(effectiveTerminalShell("cmd", posix())).toBe("system");
  });
});
