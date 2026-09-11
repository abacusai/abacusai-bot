/**
 * The Python environment the components use: a private virtualenv under the
 * app's own directory, never the system or user site-packages, so removing
 * the app removes everything it installed. Provisioned on first use, not at
 * startup, since most sessions never need it.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

import { abacusBotHome } from "../../paths";

const execFileAsync = promisify(execFile);

const VENV_DIR = (): string => path.join(abacusBotHome(), "python");

/** Import name → pip name, for the cases where they differ. */
const PIP_NAME: Record<string, string> = {
  fitz: "pymupdf",
  pptx: "python-pptx",
  PIL: "pillow",
  yaml: "pyyaml",
};

const CREATE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;

const venvPython = (): string =>
  process.platform === "win32"
    ? path.join(VENV_DIR(), "Scripts", "python.exe")
    : path.join(VENV_DIR(), "bin", "python");

const exists = async (target: string): Promise<boolean> =>
  await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

/** The first system Python that runs, or null if there is none. */
const systemPython = async (): Promise<string | null> => {
  for (const candidate of ["python3", "python"]) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 15_000 });
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
};

export type PythonEnv = {
  /** Absolute path to the interpreter to run things with. */
  python: string;
  /** Packages installed during this call, for reporting back to the user. */
  installed: string[];
};

let ensureChain: Promise<unknown> = Promise.resolve();

/**
 * An interpreter with `imports` available, installing what is missing. Throws
 * only when there is no Python at all or a package cannot be installed. Calls
 * are serialized: concurrent callers would race `python -m venv` against a
 * half-created environment and pip against its own lock.
 */
export const ensurePython = (imports: string[]): Promise<PythonEnv> => {
  const result = ensureChain.then(
    () => ensurePythonNow(imports),
    () => ensurePythonNow(imports)
  );
  ensureChain = result.catch(() => undefined);

  return result;
};

const VENV_HINT =
  'If this is Debian or Ubuntu, run "sudo apt install python3-venv" and try again.';

const createVenv = async (): Promise<void> => {
  const base = await systemPython();
  if (base == null) {
    throw new Error(
      "Python 3 is required and was not found. Install it from python.org and try again."
    );
  }
  await fs.mkdir(path.dirname(VENV_DIR()), { recursive: true });
  try {
    await execFileAsync(base, ["-m", "venv", VENV_DIR()], {
      timeout: CREATE_TIMEOUT_MS,
    });
  } catch (error) {
    // Debian ships python3 without venv, and the failed run leaves a skeleton
    // that would pass the "already created" check forever.
    await fs.rm(VENV_DIR(), { recursive: true, force: true });
    const message = (error as Error).message;
    throw new Error(
      /ensurepip/i.test(message)
        ? `Could not create a Python environment. ${VENV_HINT}`
        : message
    );
  }
};

const installPackages = async (
  python: string,
  packages: string[]
): Promise<void> => {
  await execFileAsync(
    python,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--quiet",
      ...packages,
    ],
    { timeout: INSTALL_TIMEOUT_MS }
  );
};

const ensurePythonNow = async (imports: string[]): Promise<PythonEnv> => {
  const python = venvPython();

  if (!(await exists(python))) await createVenv();

  const missing: string[] = [];
  for (const name of imports) {
    try {
      await execFileAsync(python, ["-c", `import ${name}`], {
        timeout: 30_000,
      });
    } catch {
      missing.push(PIP_NAME[name] ?? name);
    }
  }

  if (missing.length > 0) {
    try {
      await installPackages(python, missing);
    } catch (error) {
      const message = (error as Error).message;
      if (/No module named pip/i.test(message)) {
        // A skeleton venv created while python3-venv was missing: pip never
        // existed. Recreate it now that venv is complete.
        await fs.rm(VENV_DIR(), { recursive: true, force: true });
        await createVenv();
        // `missing` was measured against the old venv; the new one is empty,
        // so everything asked for has to be installed.
        const wanted = [
          ...new Set(imports.map((name) => PIP_NAME[name] ?? name)),
        ];
        try {
          await installPackages(python, wanted);
        } catch (retryError) {
          throw new Error(
            `Could not install ${wanted.join(", ")}: ${(retryError as Error).message.slice(0, 200)}. ${VENV_HINT}`
          );
        }
        return { python, installed: wanted };
      }
      throw new Error(
        `Could not install ${missing.join(", ")}: ${message.slice(0, 200)}`
      );
    }
  }

  return { python, installed: missing };
};
