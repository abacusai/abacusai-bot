import { spawnSync } from "node:child_process";
/**
 * The unit of `BashOperations.exec`'s timeout, pinned.
 *
 * This is a boundary where the type says `number` and the unit is carried only
 * by convention: pi hands a replacement backend the model's `timeout` argument
 * in SECONDS, because pi's own implementation of the interface is what converts
 * it. Reading it as milliseconds is silent: nothing fails to compile, nothing
 * throws, and it turns every command into one that is killed before it can
 * produce a byte, which reaches the model as `(no output)` and exit 1 with no
 * hint that a deadline was involved.
 *
 * That shipped. These tests are the thing that would have caught it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentShellOperations,
  backendOperations,
  deadline,
  hiddenStoreNote,
  selectedBackend,
  setPythonProvisioner,
  withManagedPython,
} from "./backends.js";
import { budgetSecondsFor } from "./extensions/tool-timeouts.js";
import { posixShell } from "./posix-shell.js";
import { sandboxBackendFor } from "./sandbox-support.js";
import { runnerPath } from "./sandbox/mxc.js";
import {
  hasRecycleBin,
  mayDeleteForGood,
  parseRm,
  rewriteCmdDeletes,
  rewritePowershell,
  touchesTrash,
  TRASH_UNAVAILABLE,
} from "./trash-shim.js";
import {
  emptiesTrash,
  emptyTrashMessage,
  outsideScope,
  resetTrashForTesting,
  setTrashMover,
  trashShimEnv,
  useTrashLaunchers,
} from "./trash.js";

describe("deadline", () => {
  it("reads its argument as seconds, not milliseconds", () => {
    vi.useFakeTimers();

    try {
      const expired = vi.fn();

      deadline(2, expired);

      // The millisecond reading fires here, 1000x early.
      vi.advanceTimersByTime(1_000);
      expect(expired).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_001);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("agrees with the budget the tool-timeouts extension stamps", () => {
    // The two modules never reference each other, so nothing but a test keeps
    // them speaking the same unit. The extension stamps `bash` with a budget in
    // seconds; a command must survive to the edge of it.
    vi.useFakeTimers();

    try {
      const budget = budgetSecondsFor("bash");
      const expired = vi.fn();

      deadline(budget, expired);

      vi.advanceTimersByTime(budget * 1_000 - 1);
      expect(expired).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no deadline when the model set none", () => {
    // pi documents bash as having no default timeout, so `undefined` has to mean
    // "run until it finishes", not "expire immediately".
    expect(deadline(undefined, vi.fn())).toBeNull();
  });

  it("has no deadline for a value that cannot be one", () => {
    // Straight from the model's arguments, so it is not necessarily a number
    // that makes sense. A zero or negative delay would otherwise be a timer that
    // fires on the next tick and kills the command instantly.
    for (const bogus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deadline(bogus, vi.fn())).toBeNull();
    }
  });
});

/**
 * The turn ends when the command ends, not when the last thing it started
 * closes its inherited pipes.
 *
 * A real session wedged here. The model restarted a dev server with
 * `cd app && nohup node server.js >> log 2>&1 &`; bash runs a backgrounded
 * compound list in a subshell, that subshell outlives the shell, and it holds
 * the tool's stdout and stderr (the redirect binds to `node`, not to the
 * subshell). The shell exited in three seconds; the tool call never returned,
 * and the session sat silent until the app's ten-minute inactivity timeout.
 */
describe("a command that leaves something running behind it", () => {
  const ops = backendOperations();
  // Only the local backend spawns processes here; docker needs a daemon and
  // `off` hands the work back to pi, whose own path already does this. Not on
  // Windows either: the checks lean on pgrep/pkill, and the bundled shell's
  // operations are pi's own, whose deadline throws rather than returning.
  const withLocalBackend =
    ops != null && selectedBackend() === "local" && process.platform !== "win32"
      ? it
      : it.skip;

  let scratch: string;
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "backends-test-"));
    // What is under test is how the spawn is waited on, which is the same
    // whether or not the command ends up confined. Running unconfined is what
    // makes that reachable everywhere: the Linux runner has a sandbox runtime
    // that cannot start, and its (correct) answer is to refuse the command
    // outright. A platform with no backend runs unconfined under `auto`.
    Object.defineProperty(process, "platform", { value: "freebsd" });
    vi.stubEnv("ABACUSAI_BOT_SANDBOX", "auto");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Alive? The token is the sleep's own duration, unique per test. */
  const survivors = (token: string): string =>
    spawnSync("pgrep", ["-f", `sleep ${token}`], {
      encoding: "utf8",
    }).stdout.trim();

  /**
   * Backgrounds a process that outlives the shell, exactly as the bug did: the
   * `&&` makes it a compound list, so bash runs it in a subshell that stays
   * alive for the sleep's duration, and the redirect binds to the `sleep`
   * inside it, leaving that subshell holding this command's stdout and stderr.
   */
  const lingering = (token: string): string =>
    `cd ${scratch} && nohup sleep ${token} >> out.log 2>&1 & \nsleep 0.2; echo READY`;

  withLocalBackend(
    "returns when the shell exits, not when the descendant does",
    async () => {
      const token = "20.7311";
      const started = Date.now();
      let output = "";

      const result = await ops!.exec(lingering(token), scratch, {
        onData: (chunk: Buffer) => {
          output += String(chunk);
        },
        timeout: 30,
      });
      const elapsed = (Date.now() - started) / 1000;

      expect(result.exitCode).toBe(0);
      expect(output).toContain("READY");
      // The descendant holds the pipes for 20s; anything near that is the hang.
      expect(elapsed).toBeLessThan(5);
      // And it must still be running, or this passed for the wrong reason: a
      // background process that died on its own holds nothing, and the wait
      // under test would never have been exercised.
      expect(survivors(token)).not.toBe("");

      spawnSync("pkill", ["-f", `sleep ${token}`]);
    }
  );

  withLocalBackend(
    "takes down what it started when the deadline expires",
    async () => {
      const token = "20.8422";

      // pi reads exactly this as "Command timed out after 1 seconds".
      await expect(
        ops!.exec(`${lingering(token)}\nsleep 30`, scratch, {
          onData: () => {},
          timeout: 1,
        })
      ).rejects.toThrow("timeout:1");
      // Killing only the shell would orphan the group rather than end it, which
      // is what left the original hang's deadline with nothing to reach.
      expect(survivors(token)).toBe("");
    }
  );
});

describe("a platform with no sandbox backend (Windows)", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    vi.unstubAllEnvs();
  });

  it("hands `auto` the confined shell where it can confine, else the bundled one, else pi's path", () => {
    // The local operations' unconfined fallback is a /bin/bash argv, which
    // does not exist on Windows: every command would fail ENOENT. Null means
    // pi's own platform-correct local path runs instead. A Windows with the
    // vendored runner on a build that can make containers is the one case
    // that keeps the operations, since there they confine.
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "local");
    vi.stubEnv("ABACUSAI_BOT_SANDBOX", "auto");
    const canConfine =
      sandboxBackendFor("win32", os.release()) === "mxc" &&
      runnerPath() != null;

    // Confined operations where the runner is there; the bundled shell's
    // where only its payload is; null on a host with neither (this suite off
    // Windows): either way, never /bin/bash.
    expect(backendOperations() == null).toBe(
      !canConfine && posixShell() == null
    );
  });

  it("keeps the operations under `strict`, so the refusal reaches the model", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "local");
    vi.stubEnv("ABACUSAI_BOT_SANDBOX", "strict");

    expect(backendOperations()).not.toBeNull();
  });

  it("refuses the docker backend outright, at construction", () => {
    // The container mounts the workspace at its host path so the model's
    // paths keep working inside, and `C:\...` is never a valid mount
    // destination or workdir in a Linux guest. One clear failure at selection
    // beats a mount error on every command.
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "docker");

    expect(() => backendOperations()).toThrow(/POSIX host path/);
  });

  it("still constructs the docker backend elsewhere", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "docker");

    expect(backendOperations()).not.toBeNull();
  });
});

describe("the note on a failed command that hit a hidden store", () => {
  it("names the store and points at the prompt, not a workaround", () => {
    const note = hiddenStoreNote(
      "cat: /home/dev/.netrc: Operation not permitted\n",
      ["/home/dev/.ssh", "/home/dev/.netrc"]
    );
    expect(note).toContain("/home/dev/.netrc");
    expect(note).toContain("approve");
    expect(note).not.toContain("/home/dev/.ssh");
  });

  it("is silent when the output mentions no store", () => {
    expect(hiddenStoreNote("npm ERR! 404", ["/home/dev/.netrc"])).toBeNull();
  });
});

describe("the app's own Python", () => {
  /** Operations that record what ran and print nothing. */
  const recorder = () => {
    const ran: string[] = [];
    return {
      ran,
      operations: {
        exec: async (command: string) => {
          ran.push(command);
          return { exitCode: 0 };
        },
      },
    };
  };
  const run = async (
    operations: ReturnType<typeof withManagedPython>,
    command: string,
    signal?: AbortSignal
  ): Promise<string> => {
    let output = "";
    await operations.exec(command, "/", {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      ...(signal != null ? { signal } : {}),
    });
    return output;
  };

  afterEach(() => {
    setPythonProvisioner(null);
    vi.useRealTimers();
  });

  it("is set up once, before the first command that runs python or pip", async () => {
    const provision = vi.fn(async () => null);
    setPythonProvisioner(provision);
    const { ran, operations } = recorder();
    const shell = withManagedPython(operations);

    await run(shell, "ls -la && echo done");
    expect(provision).not.toHaveBeenCalled();

    await Promise.all([
      run(shell, "python3 make_doc.py"),
      run(shell, "cd out; pip install pandas"),
      run(shell, "echo x | python -c 'import sys'"),
    ]);
    expect(provision).toHaveBeenCalledOnce();
    // A path to another interpreter is not this one.
    await run(shell, "./.venv/bin/python app.py");
    expect(ran).toHaveLength(5);
  });

  it("says it is waiting while the setup takes time, then that it is ready", async () => {
    vi.useFakeTimers();
    let finish = (): void => {};
    setPythonProvisioner(
      () => new Promise((resolve) => (finish = () => resolve(null)))
    );
    const { ran, operations } = recorder();

    const output = run(withManagedPython(operations), "python3 -V");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ran).toEqual([]);
    finish();

    const text = await output;
    expect(text).toContain("[python] Setting up Python for the first time");
    expect(text).toMatch(/\[python\] Python is ready \(\d+s\)/);
    expect(ran).toEqual(["python3 -V"]);
  });

  it("reports a failed setup, still runs the command, and retries next time", async () => {
    const provision = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(
        new Error("Could not set up Python: the disk is full.")
      )
      .mockResolvedValue(null);
    setPythonProvisioner(provision);
    const { ran, operations } = recorder();
    const shell = withManagedPython(operations);

    expect(await run(shell, "python3 -V")).toContain(
      "[python] Could not set up Python: the disk is full."
    );
    expect(ran).toEqual(["python3 -V"]);

    expect(await run(shell, "python3 -V")).toBe("");
    expect(provision).toHaveBeenCalledTimes(2);
  });

  it("stops waiting when the command is stopped", async () => {
    setPythonProvisioner(() => new Promise(() => {}));
    const { ran, operations } = recorder();
    const controller = new AbortController();

    const output = run(
      withManagedPython(operations),
      "pip -V",
      controller.signal
    );
    controller.abort();

    await expect(output).rejects.toThrow("aborted");
    expect(ran).toEqual([]);
  });

  it("wraps the local backend only when the desktop named the environment", () => {
    const previous = process.env.ABACUSAI_BOT_PYTHON_ENV;
    try {
      process.env.ABACUSAI_BOT_PYTHON_ENV = path.join(os.tmpdir(), "py-env");
      expect(backendOperations()).not.toBeNull();
    } finally {
      if (previous == null) delete process.env.ABACUSAI_BOT_PYTHON_ENV;
      else process.env.ABACUSAI_BOT_PYTHON_ENV = previous;
    }
  });
});

/**
 * Deletes the agent's shell makes go to the Recycle Bin / Trash, through the
 * real shell (bash, or busybox on Windows) and the real launchers, with the
 * desktop's `shell.trashItem` stood in for by a mover that records and moves.
 */
describe("deletes in the agent's shell", () => {
  const shellHere =
    process.platform !== "win32" || posixShell() != null
      ? describe
      : describe.skip;

  shellHere("go to the trash", () => {
    let root: string;
    let home: string;
    let binned: string;
    let moved: string[];
    let failWith: string | null;

    beforeEach(() => {
      resetTrashForTesting();
      // Not under the temp dir: deletes there are plain deletes by design.
      root = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.homedir(), ".abacusai-bot-trash-test-"))
      );
      home = path.join(root, "home");
      binned = path.join(root, "binned");
      fs.mkdirSync(home);
      fs.mkdirSync(binned);
      moved = [];
      failWith = null;
      setTrashMover(async (file) => {
        if (failWith != null) throw new Error(failWith);
        moved.push(file);
        fs.renameSync(
          file,
          path.join(binned, `${moved.length}-${path.basename(file)}`)
        );
      });
      vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "local");
      vi.stubEnv("ABACUSAI_BOT_SANDBOX", "off");
    });

    afterEach(() => {
      resetTrashForTesting();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const put = (...files: string[]): void => {
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), file);
      }
    };
    const there = (file: string): boolean =>
      fs.existsSync(path.join(root, file));
    const movedNames = (): string[] =>
      moved
        .map((file) => path.relative(root, file).replaceAll("\\", "/"))
        .sort();

    /** As the bash tool runs it: this process's environment, launchers on it. */
    const run = async (
      command: string,
      cwd: string = root
    ): Promise<{ code: number | null; output: string }> => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      useTrashLaunchers(env);
      let output = "";
      const { exitCode } = await agentShellOperations().exec(command, cwd, {
        onData: (data) => {
          output += String(data);
        },
        env,
        timeout: 60,
      });
      return { code: exitCode, output };
    };

    it("rm, rm -r, rm -rf, rmdir and unlink", { timeout: 60_000 }, async () => {
      put("a.txt", "b.txt", "tree/one.txt", "tree/deep/two.txt", "loose.txt");
      fs.mkdirSync(path.join(root, "empty"));

      expect((await run("rm a.txt")).code).toBe(0);
      expect((await run("rm -r tree")).code).toBe(0);
      expect((await run("rm -rf b.txt missing.txt")).code).toBe(0);
      expect((await run("rmdir empty")).code).toBe(0);
      expect((await run("unlink loose.txt")).code).toBe(0);

      // A folder goes whole, as one item the user can restore.
      expect(movedNames()).toEqual([
        "a.txt",
        "b.txt",
        "empty",
        "loose.txt",
        "tree",
      ]);
      expect(fs.readdirSync(binned)).toHaveLength(5);
      for (const gone of ["a.txt", "b.txt", "tree", "empty", "loose.txt"])
        expect(there(gone)).toBe(false);
    });

    it("keeps rm's own refusals", { timeout: 60_000 }, async () => {
      put("dir/x.txt");

      const notRecursive = await run("rm dir");
      expect(notRecursive.code).not.toBe(0);
      expect(notRecursive.output).toContain("Is a directory");
      expect((await run("rm nothing-here")).code).not.toBe(0);
      expect(moved).toEqual([]);
      expect(there("dir/x.txt")).toBe(true);
    });

    it(
      "find -delete, find -exec rm and xargs rm",
      { timeout: 60_000 },
      async () => {
        put(
          "logs/a.log",
          "logs/b.log",
          "logs/keep.txt",
          "cache/x.tmp",
          "cache/y.tmp",
          "z.bak",
          "w.bak"
        );

        expect((await run("find logs -name '*.log' -delete")).code).toBe(0);
        expect((await run("find cache -delete")).code).toBe(0);
        expect((await run("find . -name '*.bak' -exec rm {} +")).code).toBe(0);
        expect((await run("printf 'logs/keep.txt\\n' | xargs rm")).code).toBe(
          0
        );

        // A folder find matches whole goes as one item; partial matches go one by one.
        expect(movedNames()).toEqual([
          "cache",
          "logs/a.log",
          "logs/b.log",
          "logs/keep.txt",
          "w.bak",
          "z.bak",
        ]);
        expect(there("logs")).toBe(true);
      }
    );

    const hasGit = spawnSync("git", ["--version"]).status === 0;

    it.skipIf(!hasGit)(
      "git clean sends untracked files, and only those",
      { timeout: 60_000 },
      async () => {
        put("repo/tracked.txt");
        const repo = path.join(root, "repo");
        const git = (...args: string[]) =>
          spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        git("init", "-q");
        git("add", "tracked.txt");
        git(
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=t",
          "commit",
          "-qm",
          "x"
        );
        put("repo/scratch.txt", "repo/build/out.bin");

        const result = await run("git clean -fd", repo);

        expect(result.code).toBe(0);
        expect(result.output).toContain("Removing scratch.txt");
        expect(movedNames()).toEqual(["repo/build", "repo/scratch.txt"]);
        expect(there("repo/tracked.txt")).toBe(true);
        // Every other git command is git's own.
        expect((await run("git status --short", repo)).output.trim()).toBe("");
      }
    );

    // The test folder is under the home folder, so on Windows its drive has a Recycle Bin.
    const windowsWithBin =
      process.platform === "win32" && hasRecycleBin(os.homedir());

    it.skipIf(windowsWithBin)(
      "deletes anyway when the trash refuses, and says so",
      { timeout: 60_000 },
      async () => {
        put("a.txt", "tree/b.txt");
        failWith = "this drive has no Recycle Bin";

        const result = await run("rm -rf a.txt tree");

        expect(result.code).toBe(0);
        expect(there("a.txt")).toBe(false);
        expect(there("tree")).toBe(false);
        expect(result.output).toContain("this drive has no Recycle Bin");
        expect(result.output).toContain("deleted it permanently instead");
      }
    );

    it.runIf(windowsWithBin)(
      "leaves in place what Windows will not recycle, as it may be in use",
      { timeout: 60_000 },
      async () => {
        put("a.txt", "tree/b.txt", "folder/c.txt");
        // What Windows answers for a folder a process runs in, or a file held open.
        failWith = "Operation was aborted";

        const rm = await run("rm -rf a.txt tree");
        const rd = await run("cmd /c rd /s /q folder");

        expect(rm.code).not.toBe(0);
        expect(rd.code).not.toBe(0);
        for (const kept of ["a.txt", "tree/b.txt", "folder/c.txt"])
          expect(there(kept)).toBe(true);
        expect(rm.output).toContain("left it in place");
        expect(rm.output).not.toContain("permanently");
        expect(rd.output).toContain("left it in place");
      }
    );

    it(
      "deletes in the temp dir as before, with nothing to say",
      { timeout: 60_000 },
      async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trash-temp-"));
        fs.writeFileSync(path.join(scratch, "t.txt"), "x");

        const result = await run(`rm -rf '${scratch.replaceAll("\\", "/")}'`);

        expect(result.code).toBe(0);
        expect(fs.existsSync(scratch)).toBe(false);
        expect(moved).toEqual([]);
        expect(result.output).toBe("");
      }
    );

    it(
      "never deletes from the trash, even through a variable",
      { timeout: 60_000 },
      async () => {
        put(
          "home/.Trash/keep.txt",
          "home/.local/share/Trash/files/keep.txt",
          "$Recycle.Bin/S-1/keep.txt"
        );

        for (const command of [
          'T=.Tr; rm -rf "$HOME/${T}ash/keep.txt"',
          'S=share; rm -rf "$HOME/.local/$S/Tr""ash/files"',
          "B='$Recycle'; rm -rf \"./${B}.Bin/S-1\"",
          'D=.Tr; find "$HOME/${D}ash" -type f -delete',
        ]) {
          const result = await run(command);
          expect(result.code, command).not.toBe(0);
          expect(result.output, command).toContain(emptyTrashMessage());
        }
        expect(moved).toEqual([]);
        expect(there("home/.Trash/keep.txt")).toBe(true);
        expect(there("home/.local/share/Trash/files/keep.txt")).toBe(true);
        expect(there("$Recycle.Bin/S-1/keep.txt")).toBe(true);
      }
    );

    it(
      "refuses to empty the trash before the command starts",
      { timeout: 60_000 },
      async () => {
        for (const command of [
          "touch ran && Clear-RecycleBin -Force",
          "touch ran; rm -rf ~/.Trash/*",
          "touch ran; gio trash --empty",
          "touch ran; osascript -e 'tell application \"Finder\" to empty trash'",
        ]) {
          const result = await run(command);
          expect(result.code, command).toBe(1);
          expect(result.output, command).toContain(emptyTrashMessage());
          expect(there("ran"), command).toBe(false);
        }
      }
    );

    it(
      "leaves every other command as it was",
      { timeout: 60_000 },
      async () => {
        put("a.txt", "notes/n.txt");

        const result = await run(
          "echo hi && cp a.txt b.txt && mv b.txt c.txt && ls && find . -name c.txt && cat notes/n.txt"
        );

        expect(result.code).toBe(0);
        expect(result.output).toContain("hi");
        expect(result.output).toContain("./c.txt");
        expect(result.output).toContain("notes/n.txt");
        expect(there("c.txt")).toBe(true);
        expect(moved).toEqual([]);
        // Looking in the trash, or taking something back out, is fine.
        expect((await run('ls -a "$HOME"')).code).toBe(0);
      }
    );

    it(
      "confined or not, through the sandboxed operations",
      { timeout: 60_000 },
      async () => {
        // No backend on this platform: `auto` runs it unconfined, so the token widens.
        const realPlatform = Object.getOwnPropertyDescriptor(
          process,
          "platform"
        )!;
        Object.defineProperty(process, "platform", { value: "freebsd" });
        vi.stubEnv("ABACUSAI_BOT_SANDBOX", "auto");
        try {
          put("a.txt");
          if (realPlatform.value === "win32") return;
          expect((await run("rm a.txt")).code).toBe(0);
          expect(movedNames()).toEqual(["a.txt"]);
        } finally {
          Object.defineProperty(process, "platform", realPlatform);
        }
      }
    );

    const windows = process.platform === "win32" ? it : it.skip;

    windows(
      "cmd's del and rd, and PowerShell's Remove-Item and its aliases",
      { timeout: 120_000 },
      async () => {
        put("d1.txt", "d2.log", "rd/x.txt", "ps/one.txt", "ps2.txt", "ps3.txt");

        expect((await run('cmd /c "del /q d1.txt"')).code).toBe(0);
        expect((await run("cmd /c del /q *.log")).code).toBe(0);
        expect((await run('cmd /c "rd /s /q rd"')).code).toBe(0);
        expect(
          (
            await run(
              "powershell -NoProfile -Command 'Remove-Item -Recurse -Force ps'"
            )
          ).code
        ).toBe(0);
        expect(
          (
            await run(
              "powershell -NoProfile -Command 'rm ps2.txt; del ps3.txt'"
            )
          ).code
        ).toBe(0);

        expect(movedNames()).toEqual([
          "d1.txt",
          "d2.log",
          "ps",
          "ps2.txt",
          "ps3.txt",
          "rd",
        ]);
        // Not a file system item: the real cmdlet still has it.
        const env = await run(
          "powershell -NoProfile -Command '$env:ABT_X = 1; Remove-Item env:ABT_X; \"ok\"'"
        );
        expect(env.output).toContain("ok");
        // And emptying stays refused inside PowerShell, however it is reached.
        const empty = await run(
          "powershell -NoProfile -Command 'Clear-RecycleBin -Force'"
        );
        expect(empty.output).toContain(emptyTrashMessage());
      }
    );

    const hasPwsh =
      spawnSync("pwsh", ["-NoProfile", "-Command", "1"]).status === 0;

    it.skipIf(!hasPwsh || process.platform === "win32")(
      "pwsh's Remove-Item",
      { timeout: 120_000 },
      async () => {
        put("ps/one.txt", "two.txt");

        expect(
          (
            await run(
              "pwsh -NoProfile -Command 'Remove-Item -Recurse ps; Remove-Item two.txt'"
            )
          ).code
        ).toBe(0);

        expect(movedNames()).toEqual(["ps", "two.txt"]);
      }
    );
  });
});

describe("what counts as emptying the trash", () => {
  it("catches every form, wherever the path comes from", () => {
    for (const command of [
      "Clear-RecycleBin -Force",
      "powershell -NoProfile -Command 'Clear-RecycleBin -DriveLetter C -Force'",
      "rd /s /q C:\\$Recycle.Bin",
      'cmd /c "rd /s /q %SystemDrive%\\$Recycle.Bin"',
      "powershell -Command 'Remove-Item -Recurse -Force \"$env:SystemDrive\\`$Recycle.Bin\\*\"'",
      'rm -rf "/c/\\$Recycle.Bin"',
      "rm -rf ~/.Trash/*",
      'rm -rf "$HOME/.Trash"',
      "rm -rf ~/.local/share/Trash/files/*",
      'rm -rf "$XDG_DATA_HOME/Trash"',
      "find ~/.Trash -mindepth 1 -delete",
      "rm -rf /Volumes/Backup/.Trashes/501",
      "rm -rf /media/usb/.Trash-1000",
      "osascript -e 'tell application \"Finder\" to empty trash'",
      "osascript -e 'tell app \"Finder\" to empty'",
      "osascript -l JavaScript -e 'Application(\"Finder\").empty()'",
      "gio trash --empty",
      "gvfs-trash --empty",
      "trash-empty 30",
      "ktrash5 --empty",
      "gio remove trash:///old.txt",
      "(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.InvokeVerb('delete') }",
      "python3 -c \"import shutil, os; shutil.rmtree(os.path.expanduser('~/.Trash'))\"",
      "node -e \"require('fs').rmSync(process.env.HOME + '/.local/share/Trash', {recursive: true})\"",
      'python -c "import winshell; winshell.recycle_bin().empty(confirm=False)"',
    ])
      expect(emptiesTrash(command, os.tmpdir()), command).toBe(true);
  });

  it("reads the script a command runs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trash-script-"));
    try {
      fs.writeFileSync(
        path.join(dir, "tidy.ps1"),
        "Get-ChildItem\nClear-RecycleBin -Force\n"
      );
      fs.writeFileSync(path.join(dir, "fine.sh"), "rm -rf build\n");

      expect(
        emptiesTrash(
          "powershell -NoProfile -ExecutionPolicy Bypass -File tidy.ps1",
          dir
        )
      ).toBe(true);
      expect(emptiesTrash("sh ./fine.sh", dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets looking in the trash and restoring from it through", () => {
    for (const command of [
      "ls -la ~/.Trash",
      "du -sh ~/.local/share/Trash",
      "mv ~/.Trash/report.docx ~/Desktop/",
      "rm -rf build node_modules/.cache",
      "git clean -fdx",
      "echo trash",
      "Get-ChildItem C:\\Users",
    ])
      expect(emptiesTrash(command, os.tmpdir()), command).toBe(false);
  });
});

describe("when a delete the trash refused still goes ahead", () => {
  const withBin = (): boolean => true;
  const withoutBin = (): boolean => false;

  it("always off Windows", () => {
    expect(mayDeleteForGood("/a", "Operation was aborted", "linux")).toBe(true);
    expect(mayDeleteForGood("/a", "nope", "darwin", withBin)).toBe(true);
  });

  it("on Windows only where the drive has no Recycle Bin", () => {
    expect(
      mayDeleteForGood("C:\\a", "Operation was aborted", "win32", withBin)
    ).toBe(false);
    expect(
      mayDeleteForGood("E:\\a", "Operation was aborted", "win32", withoutBin)
    ).toBe(true);
  });

  it("on Windows when no trash was there to ask", () => {
    for (const reason of Object.values(TRASH_UNAVAILABLE))
      expect(mayDeleteForGood("C:\\a", reason, "win32", withBin)).toBe(true);
  });

  it("finds no Recycle Bin on a network share", () => {
    expect(hasRecycleBin("\\\\server\\share\\a.txt")).toBe(false);
    expect(hasRecycleBin("//server/share/a.txt")).toBe(false);
  });
});

describe("the trash launchers' parsing", () => {
  it("knows rm's options, and leaves an unknown one to the real rm", () => {
    expect(parseRm(["-rf", "--", "-x", "a"])).toEqual({
      recursive: true,
      force: true,
      dir: false,
      verbose: false,
      operands: ["-x", "a"],
    });
    expect(parseRm(["-R", "--verbose", "a"])?.recursive).toBe(true);
    expect(parseRm(["--frobnicate", "a"])).toBeNull();
  });

  it("names the trash wherever it is", () => {
    expect(touchesTrash("/Users/me/.Trash/x", {}, "darwin")).toBe(true);
    expect(touchesTrash("/media/usb/.Trash-1000/files", {}, "linux")).toBe(
      true
    );
    expect(touchesTrash("C:\\$Recycle.Bin\\S-1-5\\x", {}, "win32")).toBe(true);
    // A drive root or a home folder holds one.
    expect(touchesTrash("C:\\", {}, "win32")).toBe(true);
    if (process.platform !== "win32") {
      expect(touchesTrash(os.homedir())).toBe(true);
      expect(touchesTrash(path.join(os.homedir(), "projects", "app"))).toBe(
        false
      );
    }
    // The XDG trash by its name, in any home.
    expect(
      touchesTrash("/home/other/.local/share/Trash/files/x", {}, "darwin")
    ).toBe(true);
  });

  it("points cmd's own del and rd back at the launcher, and nothing else", () => {
    const line = 'cd x & del /q "a b.txt" && if exist y rd /s /q y & echo del';
    const rewritten = rewriteCmdDeletes(line, "C:/n.exe", "C:/s.js");

    expect(rewritten).toBe(
      'cd x & "C:\\n.exe" "C:\\s.js" cmd-del /q "a b.txt" && if exist y "C:\\n.exe" "C:\\s.js" cmd-rd /s /q y & echo del'
    );
    expect(rewriteCmdDeletes("dir /b", "n", "s")).toBe("dir /b");
  });

  it("puts PowerShell's Remove-Item ahead of -Command, -File and -EncodedCommand", () => {
    const command = rewritePowershell(
      ["-NoProfile", "-Command", "rm", "x"],
      "PRELUDE",
      "/w",
      false
    );
    expect(command).toEqual(["-NoProfile", "-Command", "PRELUDE rm x"]);

    const file = rewritePowershell(
      ["-ExecutionPolicy", "Bypass", "-File", "t.ps1", "-Path", "a b"],
      "P",
      "/w",
      false
    );
    expect(file?.slice(0, 3)).toEqual([
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    expect(file?.[3]).toContain(
      `& '${path.resolve("/w", "t.ps1")}' -Path 'a b'; exit $LASTEXITCODE`
    );

    const encoded = Buffer.from("Remove-Item x", "utf16le").toString("base64");
    expect(rewritePowershell(["-enc", encoded], "P", "/w", false)).toEqual([
      "-Command",
      "P Remove-Item x",
    ]);

    // An interactive shell, or a command on stdin, runs as written.
    expect(rewritePowershell(["-NoProfile"], "P", "/w", false)).toBeNull();
    expect(rewritePowershell(["-Command", "-"], "P", "/w", false)).toBeNull();
  });

  it("hands a confined command's token only what its sandbox lets it write", () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "trash-scope-"));
    try {
      const env = trashShimEnv(
        { PATH: "" },
        { roots: [fs.realpathSync.native(allowed)] }
      );
      const token = env.ABACUSAI_BOT_TRASH_TOKEN!;

      expect(outsideScope(token, path.join(allowed, "x.txt"))).toBeNull();
      expect(outsideScope(token, path.join(os.homedir(), "Documents"))).toMatch(
        /outside/
      );
      expect(outsideScope("forged", path.join(allowed, "x.txt"))).toMatch(
        /unknown/
      );
    } finally {
      resetTrashForTesting();
      fs.rmSync(allowed, { recursive: true, force: true });
    }
  });
});
