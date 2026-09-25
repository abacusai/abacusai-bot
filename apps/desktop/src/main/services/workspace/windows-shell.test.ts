/**
 * Arguments have to survive the shell that Windows forces on a .bat.
 *
 * `shell: true` stops Node passing an argv: it joins everything into one string
 * for the shell to parse again. The two tokens this code path actually carries
 * are both things a shell rewrites (an Android package id
 * (`system-images;android-34;google_apis;x86_64`) and an SDK path with a space
 * in it), so the round trip is asserted here rather than the string shape
 * alone.
 *
 * The round trip runs through this machine's shell. It is `sh` rather than
 * `cmd`, so it does not prove Windows; what it proves is the mechanism (that
 * unquoted tokens are re-split and quoted ones are not), which is the same in
 * both and is the whole reason for the helper.
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { shellCommandLine } from "./windows-shell";

const PKG = "system-images;android-34;google_apis;x86_64";
const SDK =
  "C:\\Users\\Jane Smith\\AppData\\Local\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat";

/** What a shell actually receives as separate arguments. */
const argvThroughShell = (command: string): string[] => {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return result.stdout.split("\n").filter((line) => line.length > 0);
};

// Every round trip below spawns a real shell, and the first spawn on a cold
// Windows runner can take longer than vitest's 5s default, which would time out a test
// that is only measuring quoting.
describe("quoting", { timeout: 30_000 }, () => {
  it("wraps every token, the executable included", () => {
    expect(shellCommandLine("avdmanager", ["create", "avd"])).toBe(
      '"avdmanager" "create" "avd"'
    );
  });

  it("keeps a semicolon-separated package id in one piece", () => {
    // printf %s\n prints one argument per line, so the count is the test.
    const line = shellCommandLine("printf", ["%s\\n", PKG]);
    expect(argvThroughShell(line)).toEqual([PKG]);
  });

  it("keeps a path with a space in one piece", () => {
    const line = shellCommandLine("printf", ["%s\\n", SDK]);
    expect(argvThroughShell(line)).toEqual([SDK]);
  });

  it("keeps the whole avdmanager argument list intact", () => {
    const args = [
      "create",
      "avd",
      "-n",
      "AbacusBot_android-34",
      "-k",
      PKG,
      "--force",
    ];
    const line = shellCommandLine("printf", ["%s\\n", ...args]);
    expect(argvThroughShell(line)).toEqual(args);
  });
});

describe("what happens without it", () => {
  // `sh` ends a command at `;`, which is what makes the unquoted form lose
  // everything after `system-images`. cmd.exe does not (it hands the whole
  // token over), so where this file's round trip runs through cmd there is no
  // splitting to demonstrate. The quoting the helper does is what both shells
  // need, and the tests above assert that on either one.
  it.skipIf(process.platform === "win32")(
    "splits the package id at the first semicolon",
    () => {
      // The regression, run through a real shell: this is what the old call did
      // on Windows, and why creating an emulator failed there.
      expect(argvThroughShell(`printf '%s\\n' ${PKG}`)).toEqual([
        "system-images",
      ]);
    }
  );

  it("splits the SDK path at the space", () => {
    const split = argvThroughShell(`printf '%s\\n' ${SDK}`);
    expect(split.length).toBeGreaterThan(1);
    expect(split).not.toEqual([SDK]);
  });
});

describe("tokens that could break the quoting itself", () => {
  it("survives a double quote inside a token", () => {
    const odd = 'weird"name';
    const line = shellCommandLine("printf", ["%s\\n", odd]);
    // Not asserting the exact escape, but that the token arrives as one
    // argument, which is the property that matters.
    expect(argvThroughShell(line)).toHaveLength(1);
  });

  it("leaves an empty token as an empty argument rather than dropping it", () => {
    expect(shellCommandLine("cmd", [""])).toBe('"cmd" ""');
  });
});
