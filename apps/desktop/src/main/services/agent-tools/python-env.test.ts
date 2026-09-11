/**
 * Recovering from Debian's incomplete Python.
 *
 * Debian and Ubuntu ship python3 without the venv module. `python3 -m venv`
 * then fails AFTER writing the environment's skeleton — bin/python included —
 * so a naive "does the interpreter exist" check believes the venv is ready,
 * and every pip run after that dies with "No module named pip". Installing
 * python3-venv later did not help, because the broken skeleton was never
 * removed. These tests pin the cleanup and the recovery.
 */
import type { execFile as ExecFileType } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensurePython } from "./python-env";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("child_process", () => ({ execFile: mocks.execFile }));
vi.mock("../../paths", () => ({ abacusBotHome: (): string => home }));

let home: string;

type Callback = Parameters<typeof ExecFileType>[3];

const venvDir = (): string => path.join(home, "python");
// Where the real `venv` puts the interpreter, which the code under test looks
// for. Windows uses `Scripts/python.exe`; writing a POSIX skeleton there left
// nothing for it to find, so it recreated the environment and the run counts
// this file asserts came out one too high.
const venvBinDir = (): string =>
  path.join(venvDir(), process.platform === "win32" ? "Scripts" : "bin");
const venvPython = (): string =>
  path.join(
    venvBinDir(),
    process.platform === "win32" ? "python.exe" : "python"
  );

/** Simulate `python -m venv`: write the skeleton the real one writes. */
const writeSkeleton = (): void => {
  fs.mkdirSync(venvBinDir(), { recursive: true });
  fs.writeFileSync(venvPython(), "#!/bin/sh\n");
};

type Behavior = {
  /** venv creation fails with this message; the skeleton is still written. */
  venvError?: string;
  /** pip failures, consumed one per call; empty means pip succeeds. */
  pipErrors: string[];
  /** Imports the venv already satisfies; everything else is reported missing. */
  present?: string[];
};

/** How many times `python -m venv` ran, for asserting the recreate happened. */
let venvRuns: number;
/** The package list handed to each `pip install`, in order. */
let pipInstalls: string[][];

const install = (behavior: Behavior): void => {
  venvRuns = 0;
  pipInstalls = [];
  mocks.execFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, callback: Callback) => {
      const done = (error: Error | null): void =>
        callback?.(
          error as never,
          error == null ? "ok" : "",
          error == null ? "" : (error.message ?? "")
        );

      if (args[0] === "--version") return done(null);

      if (args[0] === "-m" && args[1] === "venv") {
        venvRuns += 1;
        writeSkeleton();
        return done(
          behavior.venvError == null ? null : new Error(behavior.venvError)
        );
      }

      if (args[0] === "-c") {
        const name = (args[1] ?? "").replace(/^import\s+/, "");
        return done(
          behavior.present?.includes(name) === true
            ? null
            : new Error(`No module named ${name}`)
        );
      }

      if (args[0] === "-m" && args[1] === "pip") {
        // Everything after the flags is the package list.
        pipInstalls.push(args.filter((arg) => !arg.startsWith("-")).slice(2));
        const message = behavior.pipErrors.shift();
        return done(message == null ? null : new Error(message));
      }

      return done(new Error(`unexpected command: ${file} ${args.join(" ")}`));
    }
  );
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "python-env-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  mocks.execFile.mockReset();
});

describe("venv creation failure", () => {
  it("removes the half-written skeleton, so the next attempt starts clean", async () => {
    install({
      venvError:
        "Command failed: python3 -m venv\nEnsure pip is not disabled: ensurepip is not available. " +
        "On Debian/Ubuntu systems, you need to install the python3-venv package.",
      pipErrors: [],
    });

    await expect(ensurePython(["pypdf"])).rejects.toThrow(/python3-venv/);
    expect(fs.existsSync(venvDir())).toBe(false);
  });

  it("passes an unrelated creation failure through unchanged", async () => {
    install({
      venvError: "Command failed: disk quota exceeded",
      pipErrors: [],
    });

    await expect(ensurePython(["pypdf"])).rejects.toThrow(/disk quota/);
    expect(fs.existsSync(venvDir())).toBe(false);
  });
});

describe("a venv left behind without pip", () => {
  it("recreates the venv once and retries the install", async () => {
    // The stale skeleton from before python3-venv was installed.
    writeSkeleton();
    install({
      pipErrors: ["Command failed: /usr/bin/python: No module named pip"],
    });

    const result = await ensurePython(["pypdf"]);

    expect(result.installed).toEqual(["pypdf"]);
    expect(venvRuns).toBe(1);
    expect(fs.existsSync(venvPython())).toBe(true);
  });

  it("surfaces the Debian hint when the recreate does not help either", async () => {
    writeSkeleton();
    install({
      pipErrors: [
        "Command failed: /usr/bin/python: No module named pip",
        "Command failed: /usr/bin/python: No module named pip",
      ],
    });

    await expect(ensurePython(["pypdf"])).rejects.toThrow(/python3-venv/);
  });

  it("does not recreate on an ordinary pip failure", async () => {
    writeSkeleton();
    install({ pipErrors: ["Command failed: pip: network unreachable"] });

    await expect(ensurePython(["pypdf"])).rejects.toThrow(
      /network unreachable/
    );
    expect(venvRuns).toBe(0);
  });

  it("reinstalls everything asked for, not just what was missing before", async () => {
    // The probe runs against the OLD venv, and the recovery deletes that venv
    // whole. Installing only the previously-missing set leaves the packages the
    // old venv already had gone, while the caller is told it succeeded — and
    // the script then dies on ModuleNotFoundError.
    writeSkeleton();
    install({
      present: ["pypdf"],
      pipErrors: ["Command failed: /usr/bin/python: No module named pip"],
    });

    const result = await ensurePython(["pypdf", "fitz"]);

    expect(venvRuns).toBe(1);
    expect(pipInstalls.at(-1)).toEqual(["pypdf", "pymupdf"]);
    expect(result.installed).toEqual(["pypdf", "pymupdf"]);
  });
});
