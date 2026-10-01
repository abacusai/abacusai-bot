/**
 * Runtime resolution: how the desktop locates Python and the Node interpreter.
 *
 * The agent process is spawned as `process.execPath` (Electron's own binary)
 * with ELECTRON_RUN_AS_NODE=1 — there is no PATH lookup for Node. Python is
 * discovered through `systemPython()`, which probes `python3` then `python`.
 * These tests pin both paths and the errors that surface when a runtime is
 * missing, across platforms.
 */
import type { execFile as ExecFileType } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensurePython } from "./python-env";

// ---------------------------------------------------------------------------
// Mocks — same structure as python-env.test.ts, extended to control which
// candidate `systemPython` tries and what each one answers.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("child_process", () => ({ execFile: mocks.execFile }));
vi.mock("../../paths", () => ({ abacusBotHome: (): string => home }));

let home: string;

type Callback = Parameters<typeof ExecFileType>[3];

const venvDir = (): string => path.join(home, "python");
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

// ---------------------------------------------------------------------------
// Configurable mock that distinguishes candidates by name.
// ---------------------------------------------------------------------------

type CandidateRule = {
  /** Whether `--version` succeeds for this candidate. */
  available: boolean;
};

type Resolution = {
  /** Per-candidate rules. Key is the binary name (`python3`, `python`). */
  candidates: Record<string, CandidateRule>;
  /** venv creation fails with this message; the skeleton is still written. */
  venvError?: string;
  /** pip failures, consumed one per call; empty means pip succeeds. */
  pipErrors: string[];
  /** Imports the venv already satisfies. */
  present?: string[];
};

/** Which candidate names `systemPython` actually probed during this test. */
let probedCandidates: string[];
let venvRuns: number;

const installResolution = (resolution: Resolution): void => {
  probedCandidates = [];
  venvRuns = 0;
  mocks.execFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, callback: Callback) => {
      const done = (error: Error | null): void =>
        callback?.(
          error as never,
          error == null ? "ok" : "",
          error == null ? "" : (error.message ?? "")
        );

      if (args[0] === "--version") {
        probedCandidates.push(file);
        const rule = resolution.candidates[file];
        return done(
          rule?.available ? null : new Error(`${file}: command not found`)
        );
      }

      if (args[0] === "-m" && args[1] === "venv") {
        venvRuns += 1;
        writeSkeleton();
        return done(
          resolution.venvError == null ? null : new Error(resolution.venvError)
        );
      }

      if (args[0] === "-c") {
        const name = (args[1] ?? "").replace(/^import\s+/, "");
        return done(
          resolution.present?.includes(name) === true
            ? null
            : new Error(`No module named ${name}`)
        );
      }

      if (args[0] === "-m" && args[1] === "pip") {
        const message = resolution.pipErrors.shift();
        return done(message == null ? null : new Error(message));
      }

      return done(new Error(`unexpected command: ${file} ${args.join(" ")}`));
    }
  );
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-res-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  mocks.execFile.mockReset();
});

// ---------------------------------------------------------------------------
// systemPython resolution order
// ---------------------------------------------------------------------------

describe("systemPython resolution", () => {
  it("prefers python3 over python when both are available", async () => {
    installResolution({
      candidates: {
        python3: { available: true },
        python: { available: true },
      },
      pipErrors: [],
      present: ["pypdf"],
    });

    await ensurePython(["pypdf"]);

    // python3 was probed first and accepted; python was never tried.
    expect(probedCandidates).toEqual(["python3"]);
  });

  it("falls back to python when python3 is not available", async () => {
    installResolution({
      candidates: {
        python3: { available: false },
        python: { available: true },
      },
      pipErrors: [],
      present: ["pypdf"],
    });

    await ensurePython(["pypdf"]);

    // Both probed, python3 first then python.
    expect(probedCandidates).toEqual(["python3", "python"]);
  });

  it("throws when neither python3 nor python is available", async () => {
    installResolution({
      candidates: {
        python3: { available: false },
        python: { available: false },
      },
      pipErrors: [],
    });

    await expect(ensurePython(["pypdf"])).rejects.toThrow(
      /Python 3 is required and was not found/
    );

    // Both were tried.
    expect(probedCandidates).toEqual(["python3", "python"]);
  });

  it("provides actionable guidance in the missing-Python error", async () => {
    installResolution({
      candidates: {
        python3: { available: false },
        python: { available: false },
      },
      pipErrors: [],
    });

    await expect(ensurePython(["pypdf"])).rejects.toThrow(/python\.org/);
  });
});

// ---------------------------------------------------------------------------
// venvPython platform-specific paths
// ---------------------------------------------------------------------------

describe("venvPython platform paths", () => {
  it("places the interpreter in the platform-correct location", async () => {
    installResolution({
      candidates: { python3: { available: true }, python: { available: true } },
      pipErrors: [],
      present: ["pypdf"],
    });

    const result = await ensurePython(["pypdf"]);

    // The returned `python` field is the venv interpreter path.
    if (process.platform === "win32") {
      expect(result.python).toContain("Scripts");
      expect(result.python).toMatch(/python\.exe$/);
    } else {
      expect(result.python).toContain(path.join("bin", "python"));
      expect(result.python).not.toContain("Scripts");
    }
  });

  it("uses the venv interpreter, not the system one", async () => {
    installResolution({
      candidates: { python3: { available: true }, python: { available: true } },
      pipErrors: [],
      present: ["pypdf"],
    });

    const result = await ensurePython(["pypdf"]);

    // The path lives under the app's python venv directory, not a system path.
    expect(result.python).toContain(path.join(home, "python"));
  });
});

// ---------------------------------------------------------------------------
// Interaction between missing Python and venv creation
// ---------------------------------------------------------------------------

describe("missing Python and venv creation", () => {
  it("does not attempt venv creation when no Python is found", async () => {
    installResolution({
      candidates: {
        python3: { available: false },
        python: { available: false },
      },
      pipErrors: [],
    });

    await expect(ensurePython(["pypdf"])).rejects.toThrow();
    expect(venvRuns).toBe(0);
  });

  it("creates the venv with the first available candidate", async () => {
    // Only python is available; python3 is not.
    installResolution({
      candidates: {
        python3: { available: false },
        python: { available: true },
      },
      pipErrors: [],
      present: ["pypdf"],
    });

    const result = await ensurePython(["pypdf"]);

    expect(venvRuns).toBe(1);
    expect(result.python).toBeTruthy();
  });
});
