/**
 * Which test suite the harness thinks a project has.
 *
 * This answer is used twice: by `run_tests` when the model asks, and by the
 * verify loop when a run that touched code settles. Those were separate copies
 * of this function and they had drifted: a project configuring pytest only in
 * pyproject.toml was verified by one and invisible to the other, and gradle was
 * known to only one of them. The cases below are pinned so that cannot happen
 * quietly again.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectFramework } from "./test-runner.js";

let cwd: string;

const write = (file: string, contents = ""): void => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), contents, "utf8");
};

const name = (): string | undefined => detectFramework(cwd)?.name;
// Pinned rather than left to the host: these are the off-Windows forms, and on
// a Windows runner the default would build the Windows ones. The Windows block
// documents cmd.exe's rules, so it names that shell: on a runner with the
// bundled POSIX shell the default flavour would be POSIX.
const command = (filter?: string): string | undefined =>
  detectFramework(cwd, "linux")?.command(filter);
const winCommand = (filter?: string): string | undefined =>
  detectFramework(cwd, "win32", "cmd")?.command(filter);

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-detect-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("finding nothing", () => {
  it("returns undefined for an empty directory rather than guessing", () => {
    expect(detectFramework(cwd)).toBeUndefined();
  });

  it("ignores the npm placeholder test script", () => {
    // `npm init` writes a "test" script that only prints an error. Running it
    // would report failure for a project that simply has no tests.
    write(
      "package.json",
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      })
    );

    expect(detectFramework(cwd)).toBeUndefined();
  });
});

describe("python", () => {
  it("finds pytest from its config files", () => {
    write("pytest.ini");
    expect(name()).toBe("pytest");
  });

  it("finds pytest declared only in pyproject.toml", () => {
    // The drift case: this was visible to run_tests and invisible to the verify
    // loop, so a project shaped this way was never automatically verified.
    write("pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-q"\n');

    expect(name()).toBe("pytest");
  });

  it("finds a bare suite of test_*.py files in the root", () => {
    // The opposite drift case: known to the verify loop, invisible to run_tests.
    write("test_thing.py", "def test_x():\n    assert True\n");

    expect(name()).toBe("pytest");
  });

  it("finds python files under tests/", () => {
    write("tests/test_thing.py", "def test_x():\n    assert True\n");
    expect(name()).toBe("pytest");
  });

  it("survives `tests` being a file rather than a directory", () => {
    // readdirSync throws ENOTDIR here; an unguarded version takes the whole
    // detector down and the project gets no verification at all.
    write("tests", "not a directory");

    expect(() => detectFramework(cwd)).not.toThrow();
  });
});

describe("node", () => {
  it("prefers vitest over a generic test script", () => {
    write(
      "package.json",
      JSON.stringify({
        scripts: { test: "vitest" },
        devDependencies: { vitest: "^4" },
      })
    );

    expect(name()).toBe("vitest");
  });

  it("finds jest", () => {
    write("package.json", JSON.stringify({ devDependencies: { jest: "^29" } }));
    expect(name()).toBe("jest");
  });

  it("falls back to a real npm test script", () => {
    write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    expect(name()).toBe("npm test");
  });

  it("does not throw on an unparseable package.json", () => {
    // A half-written package.json is a normal intermediate state while the
    // agent edits it, and must not break the tool that checks its work.
    write("package.json", '{ "scripts": ');

    expect(() => detectFramework(cwd)).not.toThrow();
  });
});

describe("other ecosystems", () => {
  it("finds go, rust, gradle and cmake", () => {
    const cases: Array<[string, string]> = [
      ["go.mod", "go test"],
      ["Cargo.toml", "cargo test"],
      ["gradlew", "gradle test"],
      ["CMakeLists.txt", "cmake+catch"],
    ];

    for (const [file, expected] of cases) {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-detect-"));
      write(file);
      expect(name(), file).toBe(expected);
    }
  });
});

describe("the command it builds", () => {
  it("runs the whole suite when no filter is given", () => {
    write("pytest.ini");
    expect(command()).toBe("python3 -m pytest -q --maxfail=25");
  });

  it("uses POSIX single quotes off Windows", () => {
    write("pytest.ini");
    expect(command("a b")).toBe("python3 -m pytest -q --maxfail=25 -k 'a b'");
  });

  it("quotes a filter so a real shell cannot be made to run it", () => {
    // The filter reaches `bash -c`, so the guarantee that matters is not what
    // the string looks like (the dangerous text is still in there, inertly)
    // but what a shell does with it. Asserting against a real shell is the only
    // version of this test that cannot pass while the escaping is broken.
    write("pytest.ini");
    const marker = path.join(cwd, "pwned");
    const built = command(`x'; touch ${marker}; echo '`) ?? "";
    const quotedFilter = built.slice(built.indexOf("-k ") + 3);

    execFileSync("bash", ["-c", `printf '%s\\n' ${quotedFilter}`]);

    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("the command it builds for Windows", () => {
  it("double-quotes a filter, because cmd.exe does not quote with '", () => {
    // Single quotes are ordinary characters to cmd, so the POSIX form reached
    // the runner as part of the pattern and matched nothing, reported as a
    // clean "0 passed, 0 failed" rather than as a failure.
    write("pytest.ini");

    expect(winCommand("a b")).toBe('python -m pytest -q --maxfail=25 -k "a b"');
  });

  it("refuses a filter carrying cmd syntax rather than emitting it", () => {
    // Double quotes do not neutralise `&` for cmd: the text after it would be
    // parsed as a second command and run.
    write("pytest.ini");

    expect(() => winCommand("x & echo pwned")).toThrow(/cmd\.exe cannot carry/);
    expect(() => winCommand("a|b")).toThrow();
    expect(() => winCommand("a>b")).toThrow();
    expect(() => winCommand("%PATH%")).toThrow();
  });

  it("doubles an embedded quote, per cmd's own rule", () => {
    write("package.json", JSON.stringify({ devDependencies: { jest: "^29" } }));

    expect(winCommand('say "hi"')).toBe('npx jest -t "say ""hi"""');
  });

  it("names the interpreter Windows actually has", () => {
    // `python3` on Windows is the Store's alias stub, which exits non-zero
    // with no output, read by the verify loop as the suite failing.
    write("pytest.ini");

    expect(winCommand()).toBe("python -m pytest -q --maxfail=25");
  });

  it("calls the gradle wrapper by a name cmd can run", () => {
    // cmd reads a leading `./` as a switch, and the extensionless wrapper is a
    // shell script Windows cannot execute.
    write("gradlew");

    expect(winCommand()).toBe(
      ".\\gradlew.bat test --console=plain --no-daemon"
    );
    expect(command()).toBe("./gradlew test --console=plain --no-daemon");
  });

  it("points at the built binary with a Windows path", () => {
    write("CMakeLists.txt");
    const target = path.basename(path.resolve(cwd));

    expect(winCommand()).toContain(`&& ".\\build\\${target}"`);
    expect(command()).toContain(`&& ./build/${target}`);
  });
});
