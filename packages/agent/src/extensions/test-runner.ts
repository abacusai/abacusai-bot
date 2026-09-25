import * as fs from "node:fs";
import * as path from "node:path";

/**
 * run_tests: detect the project's test framework, run it, and return counts,
 * exit code and the first failure instead of a raw log dump. The parsed counts
 * also give outer harnesses an objective verification signal. Ported from
 * codingagent-lite (abacusai/codingagent-lite), MIT.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { execConfined } from "../backends.js";
import { posixShell } from "../posix-shell.js";
import { runFallbackShell } from "../sandbox/shell.js";

export interface Framework {
  name: string;
  command: (filter?: string) => string;
  parse: (
    output: string
  ) => { passed?: number; failed?: number; errors?: number } | undefined;
}

/** Single-quote a value for `bash -c`, so a filter can never inject shell syntax. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Characters cmd.exe still acts on inside double quotes, so a value carrying
 * one cannot be quoted for cmd at all and is refused.
 */
const CMD_UNQUOTABLE = /[&|<>^%!]/;

/** Double-quote a value for `cmd.exe /d /s /c`, per cmd's own quoting rules. */
function cmdQuote(value: string): string {
  if (CMD_UNQUOTABLE.test(value)) {
    throw new Error(
      `Filter ${JSON.stringify(value)} contains a character cmd.exe cannot ` +
        "carry inside quotes (one of & | < > ^ % !). Use a simpler filter."
    );
  }

  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The shell a command line is written for. cmd.exe only on a Windows machine
 * without the bundled POSIX shell (posix-shell.ts); with it, `execConfined`
 * runs the command under ash, which takes POSIX quoting and `./` paths.
 */
export type ShellFlavor = "posix" | "cmd";

function shellQuote(value: string, shell: ShellFlavor): string {
  return shell === "cmd" ? cmdQuote(value) : posixQuote(value);
}

/**
 * The framework a project uses, and the command line that runs it. `platform`
 * decides what the OS has (`python`, `gradlew.bat`); `shell` decides quoting
 * and path shape.
 */
export function detectFramework(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  shell: ShellFlavor = platform === "win32" && posixShell() == null
    ? "cmd"
    : "posix"
): Framework | undefined {
  const windows = platform === "win32";
  const cmd = shell === "cmd";
  const quote = (value: string): string => shellQuote(value, shell);
  const exists = (p: string) => fs.existsSync(path.join(cwd, p));
  const readIfExists = (p: string): string => {
    try {
      return fs.readFileSync(path.join(cwd, p), "utf8");
    } catch {
      return "";
    }
  };

  // A suite can be a few test_*.py files in the root with no config at all.
  const rootHasPyTests = (): boolean => {
    try {
      return fs
        .readdirSync(cwd)
        .some((f) => /^test_.*\.py$|_test\.py$/.test(f));
    } catch {
      return false;
    }
  };

  // `tests` may exist as a file, in which case readdirSync throws ENOTDIR.
  const testsDirHasPy = (): boolean => {
    try {
      const dir = path.join(cwd, "tests");
      return (
        fs.statSync(dir).isDirectory() &&
        fs.readdirSync(dir).some((f) => f.endsWith(".py"))
      );
    } catch {
      return false;
    }
  };

  // Python / pytest
  const pyproject = readIfExists("pyproject.toml");
  if (
    exists("pytest.ini") ||
    exists("conftest.py") ||
    pyproject.includes("pytest") ||
    testsDirHasPy() ||
    rootHasPyTests()
  ) {
    return {
      name: "pytest",
      // On Windows `python3` is the Store's alias stub: non-zero, no output.
      command: (filter) =>
        `${windows ? "python" : "python3"} -m pytest -q --maxfail=25${filter ? ` -k ${quote(filter)}` : ""}`,
      parse: (out) => {
        const passed = out.match(/(\d+) passed/);
        const failed = out.match(/(\d+) failed/);
        const errors = out.match(/(\d+) error/);
        if (!passed && !failed && !errors) return undefined;
        return {
          passed: passed ? Number(passed[1]) : 0,
          failed: failed ? Number(failed[1]) : 0,
          errors: errors ? Number(errors[1]) : 0,
        };
      },
    };
  }

  // Node
  const pkgRaw = readIfExists("package.json");
  if (pkgRaw) {
    let pkg: {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = {};
    try {
      pkg = JSON.parse(pkgRaw);
    } catch {
      // fall through
    }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const parseJestLike = (out: string) => {
      const m = out.match(
        /Tests:.*?(?:(\d+) failed.*?)?(\d+) passed, (\d+) total/s
      );
      if (m) return { failed: m[1] ? Number(m[1]) : 0, passed: Number(m[2]) };
      const v = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
      if (v) return { failed: v[1] ? Number(v[1]) : 0, passed: Number(v[2]) };
      return undefined;
    };
    if (allDeps.vitest) {
      return {
        name: "vitest",
        command: (f) => `npx vitest run${f ? ` -t ${quote(f)}` : ""}`,
        parse: parseJestLike,
      };
    }
    if (allDeps.jest) {
      return {
        name: "jest",
        command: (f) => `npx jest${f ? ` -t ${quote(f)}` : ""}`,
        parse: parseJestLike,
      };
    }
    if (pkg.scripts?.test && !pkg.scripts.test.includes("no test specified")) {
      return {
        name: "npm test",
        command: () => "npm test --silent",
        parse: parseJestLike,
      };
    }
  }

  // Go
  if (exists("go.mod")) {
    return {
      name: "go test",
      command: (filter) =>
        `go test ./...${filter ? ` -run ${quote(filter)}` : ""}`,
      parse: (out) => {
        const failed = (out.match(/--- FAIL/g) ?? []).length;
        const passed =
          (out.match(/--- PASS/g) ?? []).length ||
          (out.match(/^ok\s/gm) ?? []).length;
        if (failed === 0 && passed === 0) return undefined;
        return { passed, failed };
      },
    };
  }

  // Rust
  if (exists("Cargo.toml")) {
    return {
      name: "cargo test",
      // --include-ignored: Exercism-style suites mark all but the first test
      // #[ignore]; without it "the tests pass" means one test ran.
      command: (filter) =>
        `cargo test${filter ? ` ${quote(filter)}` : ""} -- --include-ignored`,
      parse: (out) => {
        let passed = 0,
          failed = 0,
          found = false;
        for (const m of out.matchAll(/(\d+) passed; (\d+) failed/g)) {
          found = true;
          passed += Number(m[1]);
          failed += Number(m[2]);
        }
        return found ? { passed, failed } : undefined;
      },
    };
  }

  // Gradle
  if (exists("gradlew")) {
    return {
      name: "gradle test",
      // The extensionless wrapper is a shell script Windows cannot run;
      // `gradlew.bat` ships beside it for exactly this (ash hands a batch
      // file to cmd.exe itself).
      command: (filter) =>
        `${cmd ? ".\\gradlew.bat" : windows ? "./gradlew.bat" : "./gradlew"} test --console=plain --no-daemon${filter ? ` --tests ${quote(filter)}` : ""}`,
      parse: (out) => {
        const m = out.match(/(\d+) tests? completed(?:, (\d+) failed)?/);
        if (!m) return undefined;
        const failed = m[2] ? Number(m[2]) : 0;
        return { passed: Number(m[1]) - failed, failed };
      },
    };
  }

  // CMake + Catch2 (Exercism-style C++: target named after the directory,
  // all but the first test gated behind EXERCISM_RUN_ALL_TESTS)
  if (exists("CMakeLists.txt")) {
    const target = path.basename(path.resolve(cwd));
    // Quoted because the directory name may contain spaces; cmd still appends
    // the PATHEXT extension to a path-qualified command, and so does ash.
    const binary = cmd
      ? `".\\build\\${target}"`
      : windows
        ? posixQuote(`./build/${target}`)
        : `./build/${target}`;
    return {
      name: "cmake+catch",
      command: (filter) =>
        `cmake -S . -B build -DCMAKE_CXX_FLAGS=-DEXERCISM_RUN_ALL_TESTS ` +
        `&& cmake --build build && ${binary}${filter ? ` ${quote(filter)}` : ""}`,
      parse: (out) => {
        const ok = out.match(
          /All tests passed \(\d+ assertions? in (\d+) test cases?\)/
        );
        if (ok) return { passed: Number(ok[1]), failed: 0 };
        const m = out.match(
          /test cases:\s*(\d+)\s*\|\s*(\d+) passed\s*\|\s*(\d+) failed/
        );
        if (m) return { passed: Number(m[2]), failed: Number(m[3]) };
        return undefined;
      },
    };
  }

  return undefined;
}

/** Pull the first failure block out of test output so the model sees the actual assertion. */
function firstFailure(output: string): string | undefined {
  const lines = output.split("\n");
  const idx = lines.findIndex((l) =>
    /FAILED|--- FAIL|✗|✖|FAIL\b|Error:|assert/i.test(l)
  );
  if (idx === -1) return undefined;
  return lines.slice(idx, idx + 30).join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description:
      "Detects and runs the project's test suite (pytest, vitest, jest, npm test, go test, cargo test) " +
      "and returns a structured summary: pass/fail counts, exit code, and the first failure. " +
      "Use run_tests instead of invoking test commands via bash: the output is compact and parsed. " +
      "Optional filter runs a subset (passed to -k / -t / -run).",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({ description: "Only run tests matching this expression" })
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default 300)" })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const framework = detectFramework(ctx.cwd);
      if (!framework) {
        return {
          content: [
            {
              type: "text",
              text: "No test framework detected (looked for pytest, jest/vitest, npm test, go.mod, Cargo.toml). Run tests via bash instead.",
            },
          ],
          isError: true,
          details: {},
        };
      }

      let command: string;

      try {
        command = framework.command(params.filter);
      } catch (error) {
        // The filter could not be quoted for the shell that would run it.
        return {
          content: [{ type: "text", text: String(error) }],
          isError: true,
          details: {},
        };
      }

      const timeoutMs = (params.timeout ?? 300) * 1000;
      // The command comes from project config the model can write, so it goes
      // through the sandbox; without a backend, the platform shell.
      const result =
        (await execConfined(command, ctx.cwd, {
          timeout: timeoutMs,
          signal,
        })) ??
        (await runFallbackShell(command, ctx.cwd, {
          timeout: timeoutMs,
          signal,
        }));

      const output = `${result.stdout}\n${result.stderr}`.trim();
      const counts = framework.parse(output);
      const failure = result.code === 0 ? undefined : firstFailure(output);

      const headerParts = [
        `framework: ${framework.name}`,
        `command: ${command}`,
        `exit code: ${result.code}${result.killed ? " (timed out)" : ""}`,
      ];
      if (counts) {
        headerParts.push(
          `result: ${counts.passed ?? 0} passed, ${counts.failed ?? 0} failed${counts.errors ? `, ${counts.errors} errors` : ""}`
        );
      }

      let body = "";
      if (result.code === 0) {
        body = counts ? "" : `\n${output.slice(-1_500)}`;
      } else {
        body = failure ? `\nFirst failure:\n${failure}` : "";
        const tail = output.slice(-3_000);
        body += `\n\nOutput tail:\n${tail}`;
      }

      return {
        content: [
          { type: "text", text: `${headerParts.join("\n")}${body}`.trim() },
        ],
        details: {
          framework: framework.name,
          exitCode: result.code,
          ...counts,
        },
        isError: result.code !== 0,
      };
    },
  });
}
