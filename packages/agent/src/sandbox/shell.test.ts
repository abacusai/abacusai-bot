/**
 * The profile is sourced once, not once per command.
 *
 * Under the sandbox a login shell per command meant every result the model read
 * carried several lines of permission errors from the user's own profile —
 * fnm's symlink, pyenv's rehash, gcloud's log file, all writing under `$HOME`
 * and all correctly refused. Spent context on every call, indistinguishable
 * from the command itself failing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  dumpShell,
  fallbackShell,
  loginEnvironment,
  mergePath,
  resetLoginEnvironment,
  runFallbackShell,
  shellArgs,
} from "./shell.js";

/** Run `body` with $SHELL set to `value` (or unset), restoring it after. */
const withShell = <T>(value: string | undefined, body: () => T): T => {
  const previous = process.env.SHELL;
  if (value == null) delete process.env.SHELL;
  else process.env.SHELL = value;
  try {
    return body();
  } finally {
    if (previous == null) delete process.env.SHELL;
    else process.env.SHELL = previous;
  }
};

describe("handing a command to a shell", () => {
  it("does not source the profile per command", () => {
    expect(shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it("keeps the command as one argument, whatever is in it", () => {
    // The shell parses it; it must never be split into argv by us.
    const command = 'echo "a b" && echo $HOME # -lc';

    expect(shellArgs(command)).toEqual(["-c", command]);
  });

  it("goes back to a login shell when asked", () => {
    // The escape hatch, for a profile that defines shell FUNCTIONS an
    // environment cannot carry — `nvm` being the one people hit.
    const previous = process.env.ABACUSAI_BOT_LOGIN_SHELL;

    process.env.ABACUSAI_BOT_LOGIN_SHELL = "1";

    try {
      expect(shellArgs("echo hi")).toEqual(["-lc", "echo hi"]);
    } finally {
      if (previous == null) delete process.env.ABACUSAI_BOT_LOGIN_SHELL;
      else process.env.ABACUSAI_BOT_LOGIN_SHELL = previous;
    }
  });
});

describe("which shell sources the profile", () => {
  it("uses the user's own login shell, not bash's idea of it", () => {
    // The macOS default. Homebrew's PATH lives in ~/.zprofile, which a bash
    // dump never sources — the whole reason the shell must be the user's.
    expect(withShell("/bin/zsh", dumpShell)).toBe("/bin/zsh");
    expect(withShell("/bin/bash", dumpShell)).toBe("/bin/bash");
  });

  it("falls back to bash for a shell the dump script is not proven in", () => {
    expect(withShell("/opt/homebrew/bin/fish", dumpShell)).toBe("/bin/bash");
    expect(withShell("/usr/local/bin/xonsh", dumpShell)).toBe("/bin/bash");
    expect(withShell(undefined, dumpShell)).toBe("/bin/bash");
  });
});

describe("the environment commands get", () => {
  it("carries a PATH, so the toolchain is findable", () => {
    // The reason the login shell was there in the first place: a GUI-launched
    // app inherits launchd's PATH, which finds none of the user's tools.
    resetLoginEnvironment();

    const env = loginEnvironment();

    expect(env.PATH).toBeTruthy();
    expect(env.PATH?.length).toBeGreaterThan(0);
  });

  it("resolves once and reuses the result", () => {
    // Per-command resolution would cost more than the login shell it replaced.
    resetLoginEnvironment();

    expect(loginEnvironment()).toBe(loginEnvironment());
  });

  it("lets this process's own environment win", () => {
    // The app sets variables deliberately — a key resolved from the keychain
    // must not be replaced by a stale one in a shell profile.
    resetLoginEnvironment();
    process.env.ABACUSAI_BOT_SHELL_ENV_PROBE = "from-process";

    try {
      expect(loginEnvironment().ABACUSAI_BOT_SHELL_ENV_PROBE).toBe(
        "from-process"
      );
    } finally {
      delete process.env.ABACUSAI_BOT_SHELL_ENV_PROBE;
      resetLoginEnvironment();
    }
  });
});

describe("what the profile's PATH may and may not replace", () => {
  // A stand-in login shell: its basename makes it eligible, and its dump is
  // fixed, so the assertions are about the merge rather than this machine's
  // real profile. Skipped on Windows, where none of this code path runs.
  const posixOnly = it.runIf(process.platform !== "win32");

  const withStubShell = <T>(body: () => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-stub-"));
    const stub = path.join(dir, "zsh");
    fs.writeFileSync(
      stub,
      "#!/bin/sh\n" +
        "printf '%s\\0' __ABACUSAI_BOT_ENV__\n" +
        "printf 'PATH=/profile/bin:/usr/bin\\0'\n" +
        "printf 'FROM_PROFILE=yes\\0'\n",
      { mode: 0o755 }
    );
    try {
      return withShell(stub, body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  posixOnly("leads with the profile's PATH", () => {
    withStubShell(() => {
      resetLoginEnvironment();
      try {
        const env = loginEnvironment();
        expect(env.FROM_PROFILE).toBe("yes");
        expect(env.PATH?.startsWith("/profile/bin:")).toBe(true);
      } finally {
        resetLoginEnvironment();
      }
    });
  });

  posixOnly("keeps the PATH entries this process added deliberately", () => {
    // The desktop repairs process.env.PATH from the user's real shell before
    // spawning the agent; replacing PATH wholesale used to throw that away.
    const previousPath = process.env.PATH;
    process.env.PATH = `/deliberate/bin:${previousPath ?? ""}`;
    withStubShell(() => {
      resetLoginEnvironment();
      try {
        const merged = loginEnvironment().PATH ?? "";
        expect(merged.split(":")).toContain("/deliberate/bin");
        expect(merged.startsWith("/profile/bin")).toBe(true);
      } finally {
        process.env.PATH = previousPath;
        resetLoginEnvironment();
      }
    });
  });
});

describe("merging the caller's PATH with the profile's", () => {
  // The POSIX cases pass ":" explicitly rather than leaning on the host's
  // path.delimiter, which is ";" on Windows and would read these as one entry.
  it("keeps the caller in front", () => {
    // pi prepends its own bin directory and expects its tools to win.
    expect(mergePath("/pi/bin", "/usr/bin:/bin", ":")).toBe(
      "/pi/bin:/usr/bin:/bin"
    );
  });

  it("reaches the toolchain the caller could not see", () => {
    // The regression this exists for. pi derives its PATH from this process's
    // environment, which in a GUI-launched app is launchd's — so letting it win
    // outright means a version-managed node is not on the path at all, and every
    // command that needs one fails with "command not found" under the sandbox.
    const merged = mergePath(
      "/pi/bin:/usr/bin",
      "/usr/bin:/Users/x/.fnm/default/bin"
    );

    expect(merged).toContain("/Users/x/.fnm/default/bin");
    expect(merged?.startsWith("/pi/bin")).toBe(true);
  });

  it("does not repeat an entry both halves have", () => {
    expect(mergePath("/usr/bin:/bin", "/bin:/usr/bin", ":")).toBe(
      "/usr/bin:/bin"
    );
  });

  it("copes with either half being absent or empty", () => {
    expect(mergePath(undefined, "/usr/bin")).toBe("/usr/bin");
    expect(mergePath("/usr/bin", undefined)).toBe("/usr/bin");
    expect(mergePath("", "")).toBeUndefined();
    expect(mergePath(undefined, undefined)).toBeUndefined();
  });

  it("drops the empty entries a stray colon leaves behind", () => {
    // An empty PATH entry means "the current directory" to most shells, which
    // is not something to inherit from a malformed profile.
    expect(mergePath("/usr/bin::", ":/bin", ":")).toBe("/usr/bin:/bin");
  });

  it("keeps drive-letter entries whole under the Windows delimiter", () => {
    // Splitting on ":" cuts `C:\...` in half; Windows PATH separates on ";".
    expect(
      mergePath("C:\\pi\\bin", "C:\\Windows\\system32;C:\\pi\\bin", ";")
    ).toBe("C:\\pi\\bin;C:\\Windows\\system32");
  });
});

describe("the shell a command falls back to without a sandbox backend", () => {
  it("is bash on POSIX", () => {
    expect(fallbackShell("npm test", "darwin", {})).toEqual({
      file: "/bin/bash",
      args: ["-c", "npm test"],
    });
  });

  it("is ComSpec on Windows, where bash does not exist", () => {
    // The regression: a hardcoded bash spawn fails ENOENT on stock Windows,
    // which callers read as the command failing with empty output.
    expect(
      fallbackShell("npm test", "win32", {
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
      })
    ).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm test"],
      // Node's default quoting is the C runtime's, and cmd.exe does not undo
      // it — the command has to reach cmd exactly as it was written.
      windowsVerbatimArguments: true,
    });
  });

  it("still finds cmd.exe when ComSpec is unset", () => {
    expect(fallbackShell("npm test", "win32", {}).file).toBe("cmd.exe");
  });

  it("keeps the command as one argument on both platforms", () => {
    const command = 'echo "a b" && echo done';

    expect(fallbackShell(command, "darwin", {}).args.at(-1)).toBe(command);
    expect(fallbackShell(command, "win32", {}).args.at(-1)).toBe(command);
  });
});

describe("running a command through the fallback shell", () => {
  // The point of spawning here rather than through pi's exec is
  // windowsVerbatimArguments, which pi's ExecOptions cannot express — so the
  // behaviour that has to hold is that the command text arrives as written.
  const posixOnly = it.runIf(process.platform !== "win32");

  posixOnly("returns stdout, stderr and the exit code", async () => {
    const result = await runFallbackShell(
      "printf out; printf err >&2; exit 3",
      os.tmpdir()
    );

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.code).toBe(3);
    expect(result.killed).toBe(false);
  });

  posixOnly("hands the command over with its quoting intact", async () => {
    // The regression this guards: a `git commit -m "msg"` re-quoted on the way
    // to the shell arrives with backslashes the shell never removes.
    const result = await runFallbackShell(`echo "a b" 'c d'`, os.tmpdir());

    expect(result.stdout.trim()).toBe("a b c d");
  });

  posixOnly("runs in the directory it was given", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fb-")));

    try {
      const result = await runFallbackShell("pwd", dir);

      expect(result.stdout.trim()).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  posixOnly(
    "reports a timeout as killed, and not as a successful run",
    async () => {
      const result = await runFallbackShell("sleep 30", os.tmpdir(), {
        timeout: 200,
      });

      expect(result.killed).toBe(true);
      // A signalled process has no exit code. Reporting 0 tells the verify
      // loop the tests passed, and it stops there.
      expect(result.code).not.toBe(0);
    },
    15_000
  );

  posixOnly(
    "settles once the command exits, even with a descendant holding the pipes",
    async () => {
      // `close` fires only when the last inherited handle is gone, and a
      // backgrounded descendant keeps stdout and stderr open long after the
      // shell itself has finished.
      const result = await runFallbackShell(
        "(sleep 20 &) ; echo done",
        os.tmpdir(),
        { timeout: 10_000 }
      );

      expect(result.stdout.trim()).toBe("done");
      expect(result.code).toBe(0);
      expect(result.killed).toBe(false);
    },
    15_000
  );

  posixOnly(
    "stops when the caller's signal aborts",
    async () => {
      const controller = new AbortController();
      const pending = runFallbackShell("sleep 30", os.tmpdir(), {
        signal: controller.signal,
      });

      controller.abort();

      const result = await pending;

      expect(result.killed).toBe(true);
      expect(result.code).not.toBe(0);
    },
    15_000
  );
});
