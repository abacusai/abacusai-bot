import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUSYBOX_ANSI_PAYLOAD,
  BUSYBOX_PAYLOAD,
  commandPosixShell,
  installPosixShell,
  posixShell,
  posixShellEnv,
  parseRegExportPath,
  registryPathEntries,
  resetPosixShellForTesting,
  resolvePosixShell,
  selfTestPosixShell,
  type PosixShell,
} from "./posix-shell-install.js";
import {
  scriptRuntimesPrompt,
  posixShellOperations,
  toolchainPrompt,
  windowsShellPrompt,
  windowsToolchain,
  WINDOWS_TOOLCHAIN,
} from "./posix-shell.js";

const payload = fileURLToPath(
  new URL("../vendor/busybox.exe", import.meta.url)
);
const ansiPayload = fileURLToPath(
  new URL("../vendor/busybox-ansi.exe", import.meta.url)
);

/** What the Unicode build prints on a Windows before 10 1903. */
const MANIFEST_REFUSAL = "sh.exe: UTF8 manifest not supported";

describe("resolvePosixShell", () => {
  /** Stand-in payloads: the install only copies and links them. */
  const vendor = (builds: readonly string[]) => {
    const root = mkdtempSync(join(tmpdir(), "busybox-resolve-"));
    for (const build of builds)
      writeFileSync(join(root, build), `stand-in ${build}`);

    return {
      root,
      payload: join(root, BUSYBOX_PAYLOAD),
      cacheRoot: join(root, "cache"),
      done: () => rmSync(root, { recursive: true, force: true }),
    };
  };
  const both = [BUSYBOX_PAYLOAD, BUSYBOX_ANSI_PAYLOAD];

  it("keeps the Unicode build when it runs", () => {
    const v = vendor(both);
    try {
      const selfTest = vi.fn(() => undefined);
      const shell = resolvePosixShell({
        platform: "win32",
        payload: v.payload,
        cacheRoot: v.cacheRoot,
        selfTest,
      });
      expect(shell?.ansi).toBeUndefined();
      expect(shell?.sh.startsWith(v.cacheRoot)).toBe(true);
      expect(selfTest).toHaveBeenCalledOnce();
    } finally {
      v.done();
    }
  });

  it("falls back to the ANSI build when the Unicode one refuses its manifest", () => {
    const v = vendor(both);
    try {
      const tested: PosixShell[] = [];
      const shell = resolvePosixShell({
        platform: "win32",
        payload: v.payload,
        cacheRoot: v.cacheRoot,
        selfTest: (candidate) => {
          tested.push(candidate);
          return candidate.ansi === true ? undefined : MANIFEST_REFUSAL;
        },
      });
      expect(shell?.ansi).toBe(true);
      expect(tested.map((candidate) => candidate.ansi === true)).toEqual([
        false,
        true,
      ]);
      // Each build in its own digest-keyed install.
      expect(shell?.sh).not.toBe(tested[0]?.sh);
    } finally {
      v.done();
    }
  });

  it("gives up, leaving the no-bundled-shell path, when no build runs", () => {
    for (const builds of [both, [BUSYBOX_PAYLOAD]]) {
      const v = vendor(builds);
      try {
        const selfTest = vi.fn(() => MANIFEST_REFUSAL);
        expect(
          resolvePosixShell({
            platform: "win32",
            payload: v.payload,
            cacheRoot: v.cacheRoot,
            selfTest,
          })
        ).toBeUndefined();
        expect(selfTest).toHaveBeenCalledTimes(builds.length);
      } finally {
        v.done();
      }
    }
  });

  it("only applies on Windows", () => {
    const selfTest = vi.fn(() => undefined);
    expect(resolvePosixShell({ platform: "darwin", selfTest })).toBeUndefined();
    expect(selfTest).not.toHaveBeenCalled();
  });

  it("fails the probe with the shell's own words", () => {
    // A shell that is not there: the spawn error is the reason.
    expect(
      selfTestPosixShell(
        {
          sh: join(tmpdir(), "no-such-shell.exe"),
          bin: tmpdir(),
          overrideApplets: "",
        },
        process.env
      )
    ).toMatch(/ENOENT/);
  });
});

describe("posixShell", () => {
  afterEach(() => resetPosixShellForTesting());

  /** A stand-in payload and the options that install it, as on Windows. */
  const staged = (selfTest: () => string | undefined) => {
    const root = mkdtempSync(join(tmpdir(), "busybox-memo-"));
    const stub = join(root, BUSYBOX_PAYLOAD);
    writeFileSync(stub, "stand-in busybox");

    return {
      options: {
        platform: "win32" as const,
        payload: stub,
        cacheRoot: join(root, "cache"),
        selfTest: vi.fn(selfTest),
      },
      done: () => rmSync(root, { recursive: true, force: true }),
    };
  };

  it("reinstalls a launcher removed after its self-test, then keeps it", () => {
    const s = staged(() => undefined);
    try {
      const first = posixShell(s.options);
      expect(first).toBeDefined();
      // What a quarantine leaves: the folder and the other launchers, no sh.exe.
      rmSync(first!.sh);

      const again = posixShell(s.options);
      expect(again?.sh).toBe(first!.sh);
      expect(existsSync(again!.sh)).toBe(true);
      expect(posixShell(s.options)).toBe(again);
      expect(s.options.selfTest).toHaveBeenCalledTimes(2);
    } finally {
      s.done();
    }
  });

  it("fails the command, naming the shell, when the removed one cannot be restored", () => {
    let runs = true;
    const s = staged(() => (runs ? undefined : "blocked"));
    try {
      const first = commandPosixShell(s.options);
      expect(first).toBeDefined();
      rmSync(first!.sh);
      runs = false;

      expect(() => commandPosixShell(s.options)).toThrow(
        /was removed and could not be reinstalled/
      );
      // The 30 s recheck stands: the next command fails at once, unprobed.
      const probes = s.options.selfTest.mock.calls.length;
      expect(() => commandPosixShell(s.options)).toThrow(first!.sh);
      expect(s.options.selfTest).toHaveBeenCalledTimes(probes);
    } finally {
      s.done();
    }
  });

  it("leaves the no-bundled-shell path where there never was one", () => {
    expect(commandPosixShell({ platform: "linux" })).toBeUndefined();
  });
});

it.skipIf(process.platform !== "win32" || !existsSync(ansiPayload))(
  "runs commands under the shipped ANSI build when the Unicode one cannot start",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "busybox-ansi-"));
    try {
      // This runner's Windows is new enough for both, so the refusal is staged;
      // the ANSI build's probe and the command after it are real.
      const shell = resolvePosixShell({
        payload,
        cacheRoot: join(root, "cache"),
        selfTest: (candidate, env) =>
          candidate.ansi === true
            ? selfTestPosixShell(candidate, env)
            : MANIFEST_REFUSAL,
      });
      expect(shell?.ansi).toBe(true);
      const output: Buffer[] = [];
      const result = await posixShellOperations(shell)?.exec(
        "printf 'b\\na\\n' | sort | head -1",
        root,
        { onData: (chunk) => output.push(chunk) }
      );
      expect(result?.exitCode).toBe(0);
      expect(Buffer.concat(output).toString().trim()).toBe("a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== "win32" || !existsSync(payload))(
  "picks the Unicode build on a Windows that supports it",
  () => {
    const root = mkdtempSync(join(tmpdir(), "busybox-unicode-"));
    try {
      const shell = resolvePosixShell({
        payload,
        cacheRoot: join(root, "cache"),
      });
      expect(shell).toBeDefined();
      expect(shell?.ansi).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== "win32" || !existsSync(payload))(
  "runs the shipped shell directly when its cache cannot be created",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "busybox-fallback-"));
    try {
      const blockedRoot = join(root, "blocked");
      writeFileSync(blockedRoot, "not a directory");
      const shell = installPosixShell({ payload, cacheRoot: blockedRoot });
      expect(shell?.sh).toBe(payload);
      expect(shell?.args).toEqual(["sh"]);
      const output: Buffer[] = [];
      const result = await posixShellOperations(shell)?.exec(
        "printf 'ok'",
        root,
        {
          onData: (chunk) => output.push(chunk),
        }
      );
      expect(result?.exitCode).toBe(0);
      expect(Buffer.concat(output).toString()).toBe("ok");
      expect(
        execFileSync(payload, ["sh", "-c", "printf ok"], { encoding: "utf8" })
      ).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

const fakeShell = {
  sh: "C:/bb/bin/sh.exe",
  bin: "C:/bb/bin",
  overrideApplets: ";x",
};

describe("registryPathEntries", () => {
  const registry = (values: Record<string, string>) => (key: string) =>
    values[key.startsWith("HKLM") ? "machine" : "user"];

  it("returns machine then user entries this process lacks, expanded, once each", () => {
    const fresh = registryPathEntries(
      {
        PATH: "C:\\Windows\\system32;C:\\Tools\\",
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\U",
      },
      registry({
        machine: "%SYSTEMROOT%\\System32;C:\\Program Files\\Git\\cmd;C:\\Tools",
        user: "%USERPROFILE%\\AppData\\Roaming\\npm;C:\\Program Files\\Git\\cmd;%NOPE%\\bin",
      })
    );
    expect(fresh?.split(";")).toEqual([
      "C:\\Program Files\\Git\\cmd",
      "C:\\Users\\U\\AppData\\Roaming\\npm",
      "%NOPE%\\bin",
    ]);
  });

  it("is nothing when the registry cannot be read or adds nothing", () => {
    expect(
      registryPathEntries({ PATH: "C:\\A" }, () => undefined)
    ).toBeUndefined();
    expect(
      registryPathEntries({ PATH: "C:\\A" }, registry({ machine: "c:\\a\\" }))
    ).toBeUndefined();
  });

  it("goes after the process's own PATH for the child, never before it", () => {
    const env = posixShellEnv(
      { PATH: "system" },
      { ...fakeShell, bin: "applets" },
      "nodejs"
    );
    expect(env.PATH?.split(delimiter)).toEqual(["applets", "system", "nodejs"]);
  });

  it("reads both shapes reg export writes", () => {
    const utf16 = (text: string) =>
      Buffer.from(`${text}\0`, "utf16le")
        .toJSON()
        .data.map((byte) => byte.toString(16).padStart(2, "0"))
        .join(",");
    const expand =
      "%USERPROFILE%\\AppData\\Local\\Programs\\Python;C:\\Users\\José\\bin";
    const hex = utf16(expand);
    // Wrapped the way reg export wraps a long value.
    const wrapped = `${hex.slice(0, 60)}\\\r\n  ${hex.slice(60)}`;
    expect(
      parseRegExportPath(
        `\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n"TEMP"="x"\r\n"Path"=hex(2):${wrapped}\r\n`
      )
    ).toBe(expand);
    expect(
      parseRegExportPath(
        '"Path"="C:\\\\Program Files\\\\Git\\\\cmd;C:\\\\Şükrü"\r\n'
      )
    ).toBe("C:\\Program Files\\Git\\cmd;C:\\Şükrü");
    expect(parseRegExportPath('"TEMP"="x"\r\n')).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")(
    "reads this machine's registry PATH",
    () => {
      expect(
        registryPathEntries({
          PATH: "",
          SystemRoot: process.env.SystemRoot,
        })?.toLowerCase()
      ).toContain("system32");
    }
  );
});

describe("posixShellEnv temp dir", () => {
  it("fills TMPDIR from the Windows temp dir when it is missing", () => {
    const env = posixShellEnv(
      { Path: "C:/Windows", TEMP: "C:/Users/U/Temp", TMP: "C:/Users/U/Tmp" },
      fakeShell
    );
    expect(env.TMPDIR).toBe("C:/Users/U/Temp");
    expect(env.TEMP).toBe("C:/Users/U/Temp");
    expect(env.TMP).toBe("C:/Users/U/Tmp");
  });

  it("never overrides a value that is there, whatever its case", () => {
    const env = posixShellEnv(
      { Path: "C:/Windows", TmpDir: "D:/scratch", Temp: "C:/T" },
      fakeShell
    );
    expect(env.TmpDir).toBe("D:/scratch");
    expect(env.Temp).toBe("C:/T");
    expect(env.TMP).toBe("C:/T");
    expect(
      Object.keys(env).filter((k) => k.toUpperCase() === "TMPDIR")
    ).toEqual(["TmpDir"]);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "TEMP")).toEqual([
      "Temp",
    ]);
  });

  it("falls back to the OS temp dir when none is set, or the one set is empty", () => {
    expect(posixShellEnv({ Path: "C:/Windows" }, fakeShell)).toMatchObject({
      TMPDIR: tmpdir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
    });
    expect(posixShellEnv({ TEMP: "" }, fakeShell)).toMatchObject({
      TEMP: "",
      TMP: tmpdir(),
      TMPDIR: tmpdir(),
    });
  });

  it("only applies where the bundled shell exists, which is Windows", () => {
    expect(installPosixShell({ platform: "darwin" })).toBeUndefined();
    expect(installPosixShell({ platform: "linux" })).toBeUndefined();
  });
});

describe("windowsShellPrompt", () => {
  // The fixed part; the inventory is the machine's and is tested below.
  const prompt = windowsShellPrompt(fakeShell, "") ?? "";

  it("states the shell's facts the model gets wrong", () => {
    for (const fact of [
      "busybox ash",
      "'C:/Users/Name/project'",
      "/mnt/c",
      "'C:/Program Files/...'",
      "no /tmp",
      '"$TMPDIR"',
      "nohup",
      "`background`",
      "command -v",
      "%NAME%",
      "powershell -NoProfile -Command '",
      "-File",
    ])
      expect(prompt).toContain(fact);
  });

  it("stays short: it is in every Windows turn's system prompt", () => {
    expect(prompt.length).toBeLessThan(1_800);
    expect(prompt.split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  it("tells the model when its shell is the ANSI build, and only then", () => {
    const ansi = windowsShellPrompt({ ...fakeShell, ansi: true }, "") ?? "";
    expect(ansi.startsWith(prompt)).toBe(true);
    expect(ansi).toContain("Unicode shell");
    expect(ansi).toContain("write tool");
    expect(prompt).not.toContain("Unicode shell");
    expect(ansi.length).toBeLessThan(2_100);
    expect(ansi.split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  it("never claims an interpreter is installed: the inventory says which are", () => {
    expect(prompt).not.toMatch(/\b(node|python)\b/);
    const inventory = toolchainPrompt({ present: ["git"], missing: [] });
    const full = windowsShellPrompt(fakeShell, inventory);
    expect(full?.endsWith(inventory)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "is absent on macOS and Linux",
    () => {
      expect(windowsShellPrompt()).toBeNull();
      expect(windowsShellPrompt(undefined)).toBeNull();
    }
  );
});

describe("windowsToolchain", () => {
  /** A machine whose PATH holds `files` (name to path). */
  const machine = (files: Record<string, string>, runs = () => true) => ({
    find: (name: string) => files[name],
    runs: vi.fn(runs),
  });

  it("sorts every tool into present or missing, on the PATH commands get", () => {
    const seen: string[] = [];
    const toolchain = windowsToolchain(
      fakeShell,
      { PATH: "C:/Program Files/Git/cmd" },
      {
        find: (name, pathValue) => {
          seen.push(pathValue);
          return name === "git"
            ? "C:/Program Files/Git/cmd/git.exe"
            : undefined;
        },
        runs: () => true,
      }
    );
    expect(toolchain.present).toEqual(["git"]);
    expect(toolchain.missing).toEqual(
      WINDOWS_TOOLCHAIN.filter((n) => n !== "git")
    );
    // The applet directory leads, as it does for a command.
    expect(seen[0]?.startsWith(fakeShell.bin)).toBe(true);
  });

  it("counts a Store alias only when it runs", () => {
    const alias = "C:/Users/U/AppData/Local/Microsoft/WindowsApps/python3.exe";
    const stub = machine({ python3: alias }, () => false);
    expect(windowsToolchain(fakeShell, {}, stub).missing).toContain("python3");
    expect(stub.runs).toHaveBeenCalledWith(alias);

    const real = machine({ python3: alias, node: "C:/nodejs/node.exe" });
    const toolchain = windowsToolchain(fakeShell, {}, real);
    expect(toolchain.present).toEqual(["python3", "node"]);
    // Only the alias is run; a plain file on PATH is trusted.
    expect(real.runs).toHaveBeenCalledOnce();
  });

  it("counts the app's own Python as there before it is set up", () => {
    const toolchain = windowsToolchain(
      fakeShell,
      { ABACUSAI_BOT_PYTHON_ENV: "C:/Users/U/.abacusai-bot/python" },
      machine({})
    );
    expect(toolchain.present).toEqual(["python", "pip"]);
    // No python3 in a Windows environment: the prompt says to use `python`.
    expect(toolchainPrompt(toolchain)).toContain("run Python as `python`");
  });

  it("names what is missing and how to start the Python that is there", () => {
    const text = toolchainPrompt({
      present: ["py", "git"],
      missing: ["python", "python3", "node"],
    });
    expect(text).toContain("On PATH when this session started:\n  py, git.");
    expect(text).toContain("do not call them:\n  python, python3, node.");
    expect(text).toContain(".venv/Scripts/python.exe");
    expect(text).toContain("run Python as `py -3`");
    expect(
      toolchainPrompt({ present: ["python"], missing: ["python3"] })
    ).toContain("run Python as `python`");
    expect(
      toolchainPrompt({ present: ["python3"], missing: [] })
    ).not.toContain("no python3");
    expect(toolchainPrompt({ present: [], missing: ["node"] })).toContain(
      "none of the usual interpreters"
    );
    expect(
      toolchainPrompt({ present: ["git"], missing: [...WINDOWS_TOOLCHAIN] })
        .split("\n")
        .every((line) => line.length <= 100)
    ).toBe(true);
  });
});

it.skipIf(process.platform !== "win32" || !existsSync(payload))(
  "takes the runner's real toolchain through the shipped shell's PATH",
  () => {
    const root = mkdtempSync(join(tmpdir(), "busybox-toolchain-"));
    try {
      const shell = resolvePosixShell({
        payload,
        cacheRoot: join(root, "cache"),
      });
      if (shell == null) throw new Error("no shell");
      // The runner has both; the shell's own `command -v` agrees.
      const toolchain = windowsToolchain(shell);
      expect(toolchain.present).toEqual(
        expect.arrayContaining(["git", "node"])
      );
      const env = posixShellEnv(process.env, shell);
      for (const name of toolchain.present.filter(
        (n) => n === "git" || n === "node"
      ))
        expect(
          execFileSync(
            shell.sh,
            [...(shell.args ?? []), "-c", `command -v ${name}`],
            {
              encoding: "utf8",
              env,
            }
          ).trim().length
        ).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== "win32" || !existsSync(payload))(
  "gives the shipped shell a usable $TMPDIR",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "busybox-tmpdir-"));
    try {
      const shell = installPosixShell({
        payload,
        cacheRoot: join(root, "cache"),
      });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k.toUpperCase() !== "TMPDIR"
        )
      );
      const output: Buffer[] = [];
      const result = await posixShellOperations(shell)?.exec(
        'cd "$TMPDIR" && f=$(mktemp) && printf ok > "$f" && cat "$f" && rm "$f"',
        root,
        { onData: (chunk) => output.push(chunk), env }
      );
      expect(Buffer.concat(output).toString()).toBe("ok");
      expect(result?.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

describe("scriptRuntimesPrompt", () => {
  const python = {
    ABACUSAI_BOT_PYTHON_ENV: "/home/u/.abacusai-bot/shell-python",
  };
  const node = {
    ABACUSAI_BOT_NODE:
      "/Applications/AbacusAI-Bot.app/Contents/MacOS/AbacusAI-Bot",
  };

  it("is absent when neither runtime is the app's", () => {
    expect(scriptRuntimesPrompt({}, "linux")).toBeNull();
  });

  it("points Word and Excel work at the app's Node and its libraries", () => {
    const text = scriptRuntimesPrompt(node, "darwin") ?? "";
    expect(text).toContain('"$ABACUSAI_BOT_NODE" script.cjs');
    expect(text).toContain("`docx`, `mammoth`");
    expect(text).toContain("PDFs go");
    expect(text).not.toContain("pip");
  });

  it("says python and pip work, and that the first use downloads it", () => {
    const text = scriptRuntimesPrompt({ ...node, ...python }, "darwin") ?? "";
    expect(text).toContain("`python3`, `python` and `pip`");
    expect(text).toContain("The first command that uses it downloads it");
    // Windows environments have no python3.
    const windows = scriptRuntimesPrompt(python, "win32") ?? "";
    expect(windows).toContain("`python` and `pip`");
    expect(windows).not.toContain("python3");
  });
});
