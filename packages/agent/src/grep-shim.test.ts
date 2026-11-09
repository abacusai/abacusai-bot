import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { grepShimEnv, resetGrepLaunchersForTesting } from "./grep-launcher.js";
import { parseGrepArgs } from "./grep-shim.js";
import { installPosixShell, type PosixShell } from "./posix-shell-install.js";
import { posixShellOperations } from "./posix-shell.js";

const payload = fileURLToPath(
  new URL("../vendor/busybox.exe", import.meta.url)
);
const vendor = fileURLToPath(new URL("../vendor", import.meta.url));
const windows = process.platform === "win32";

describe("parseGrepArgs", () => {
  it.each([
    [
      ["-rn", "goal", "--include=*.py", "."],
      {
        flags: ["n", "r"],
        include: ["*.py"],
        patterns: ["goal"],
        files: ["."],
      },
    ],
    [
      ["-r", "--include=*.{ts,tsx}", "--exclude-dir", "node_modules", "x"],
      { include: ["*.ts", "*.tsx"], excludeDir: ["node_modules"], files: [] },
    ],
    [
      ["--line-number", "--ignore-case", "X", "src"],
      { flags: ["i", "n"], patterns: ["X"], files: ["src"] },
    ],
    [["-oP", "\\d+", "f"], { matcher: "P", flags: ["o"], patterns: ["\\d+"] }],
    [
      ["--incl=*.py", "-m5", "-3", "x"],
      { include: ["*.py"], values: { m: "5", C: "3" } },
    ],
    [["-e", "-x", "--", "-file"], { patterns: ["-x"], files: ["-file"] }],
    [["-n5", "x"], { flags: ["n"], values: { C: "5" } }],
    [["-5n", "x"], { flags: ["n"], values: { C: "5" } }],
  ])("reads %j as GNU grep does", (args, expected) => {
    const command = parseGrepArgs(args);
    const got = {
      matcher: command.matcher,
      flags: [...command.flags].sort(),
      values: Object.fromEntries(command.values),
      patterns: command.patterns,
      include: command.include,
      excludeDir: command.excludeDir,
      files: command.files,
    };
    expect(got).toMatchObject(expected);
  });

  it.each([
    [["--label=x", "a"], "--label is not available"],
    [["-b", "a", "f"], "only with -P"],
    [["--frobnicate", "a"], "unrecognized option"],
    [["-m", "many", "a"], "invalid -m argument"],
    [["-E", "-P", "a"], "conflicting matchers"],
  ])("refuses %j", (args, message) => {
    expect(() => parseGrepArgs(args)).toThrow(message);
  });
});

/**
 * GNU-style searches, run the way the agent runs them: on Windows through the
 * bundled busybox shell and its launchers; elsewhere through the same launcher
 * under `sh`, with the system grep standing in for BusyBox's matcher.
 */
describe("grep under the agent shell, run for real", () => {
  let root: string;
  let project: string;
  let run: (
    command: string
  ) => Promise<{ exitCode: number | null; lines: string[] }>;
  const previousHome = process.env.ABACUSAI_BOT_HOME;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "grep-shim-"));
    process.env.ABACUSAI_BOT_HOME = join(root, "home");
    resetGrepLaunchersForTesting();
    project = join(root, "project");
    const files: Record<string, string> = {
      "src/main.py":
        "import os\nfrom pkg import goal_engine\nx = 1234\ntime.sleep(2)\n",
      "src/pkg/goal_engine.py":
        "def run():\n    time.sleep(1)\n    return 42\n",
      "src/app.js": 'const goal_engine = require("x");\n',
      "node_modules/dep/index.js": "goal_engine\n",
      ".git/config": "goal_engine in git\n",
      "notes.txt": "hello\nworld\n",
      "data.bin": "a\0b\nfoo\n",
    };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(project, name, ".."), { recursive: true });
      writeFileSync(join(project, name), text);
    }

    let shell: PosixShell;
    if (windows) {
      shell = installPosixShell({ payload, cacheRoot: join(root, "cache") })!;
    } else {
      // BusyBox's grep: the system grep behind BusyBox's option set, which
      // answers any other option with usage and status 2.
      const system = execFileSync("sh", ["-c", "command -v grep"], {
        encoding: "utf8",
      }).trim();
      const standIn = join(root, "busybox");
      writeFileSync(
        standIn,
        [
          "#!/bin/sh",
          "shift",
          'for arg in "$@"; do',
          '  case "$arg" in',
          "    --) break ;;",
          "    --color|--color=*) ;;",
          "    --?*|-*[!HhnlLoqvsrRiwFEIacxmABCef0-9]*) echo 'Usage: grep [-HhnlLoqvsrRiwFE]' >&2; exit 2 ;;",
          "  esac",
          "done",
          `exec '${system}' "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      shell = { sh: standIn, args: ["sh"], bin: root, overrideApplets: "" };
    }
    const ops = posixShellOperations(shell)!;
    run = async (command) => {
      let output = "";
      const env = grepShimEnv(
        {
          ...(process.env as Record<string, string>),
          PATH: `${process.env.PATH ?? ""}${delimiter}${vendor}`,
        },
        shell
      );
      let exitCode: number | null;
      if (windows) {
        ({ exitCode } = await ops.exec(command, project, {
          onData: (data) => (output += data.toString()),
          env,
        }));
      } else {
        const child = spawnSync("sh", ["-c", command], {
          cwd: project,
          env,
          encoding: "utf8",
        });
        output = child.stdout + child.stderr;
        exitCode = child.status;
      }
      const lines = output
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => line.length > 0)
        .sort();

      return { exitCode, lines };
    };
  });

  afterAll(() => {
    if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = previousHome;
    resetGrepLaunchersForTesting();
    rmSync(root, { recursive: true, force: true });
  });

  const rows: Array<[string, string[]]> = [
    [
      "grep -rn goal_engine --include=*.py . 2>/dev/null",
      ["./src/main.py:2:from pkg import goal_engine"],
    ],
    [
      "grep -rln goal_engine . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null",
      ["./src/app.js", "./src/main.py"],
    ],
    [
      "grep -rn sleep --include=*.{py,js} src 2>/dev/null",
      [
        "src/main.py:4:time.sleep(2)",
        "src/pkg/goal_engine.py:2:    time.sleep(1)",
      ],
    ],
    [
      "grep -rn 'sleep\\|return' --include=*.py src 2>/dev/null",
      [
        "src/main.py:4:time.sleep(2)",
        "src/pkg/goal_engine.py:2:    time.sleep(1)",
        "src/pkg/goal_engine.py:3:    return 42",
      ],
    ],
    [
      "grep -rl goal_engine 2>/dev/null",
      [".git/config", "node_modules/dep/index.js", "src/app.js", "src/main.py"],
    ],
    ["grep -c --ignore-case HELLO notes.txt 2>/dev/null", ["1"]],
    ["grep -oP '(?<=x = )\\d+' src/main.py 2>/dev/null", ["1234"]],
    [
      "grep -rnP 'sleep\\(\\d\\)' --include=*.py . 2>/dev/null",
      [
        "./src/main.py:4:time.sleep(2)",
        "./src/pkg/goal_engine.py:2:    time.sleep(1)",
      ],
    ],
    [
      "grep -rP 'fo+' --include=*.bin . ; echo rc=$?",
      [
        './data.bin: binary file matches (found "\\0" byte around offset 1)',
        "rc=0",
      ],
    ],
    ["grep -r --exclude-dir=pkg sleep src/pkg; echo rc=$?", ["rc=1"]],
    [
      "grep -r --exclude-dir=pkg sleep src/pkg/",
      ["src/pkg/goal_engine.py:    time.sleep(1)"],
    ],
    ["grep -r sleep src/main.py", ["time.sleep(2)"]],
    [
      "grep -n1 'x = ' src/main.py",
      ["2-from pkg import goal_engine", "3:x = 1234", "4-time.sleep(2)"],
    ],
    ["grep -m1 o notes.txt", ["hello"]],
    ["grep -nA1 hello notes.txt", ["1:hello", "2-world"]],
    ["grep -rq goal_engine --include=*.py src && echo found", ["found"]],
    ["grep -rn nomatch --include=*.py src; echo rc=$?", ["rc=1"]],
    ["printf 'a\\nb\\n' | grep -v a", ["b"]],
    ["printf 'a\\nB\\n' | grep --ignore-case b", ["B"]],
    // The applet on its own, as the shell ran it before: blind behind 2>/dev/null.
    [
      '"$ABACUSAI_BOT_BUSYBOX" grep -rn goal_engine --include=*.py . 2>/dev/null; echo rc=$?',
      ["rc=2"],
    ],
  ];

  it
    .skipIf(
      (windows && !existsSync(payload)) ||
        (!windows && !existsSync(join(vendor, "rg")))
    )
    .each(rows)("%s", async (command, expected) => {
    const { lines } = await run(command);
    expect(lines).toEqual(expected);
  });

  it.skipIf(windows && !existsSync(payload))(
    "shows an option it cannot honour even with stderr discarded",
    async () => {
      const { lines } = await run(
        "grep --label=x hello notes.txt 2>/dev/null; echo rc=$?"
      );
      expect(lines).toContain("rc=2");
      expect(lines.some((line) => line.startsWith("grep: --label"))).toBe(true);
      const conflict = await run(
        "grep -E -P x notes.txt 2>/dev/null; echo rc=$?"
      );
      expect(conflict.lines).toContain("grep: conflicting matchers specified");
      expect(conflict.lines).toContain("rc=2");
    }
  );
});
