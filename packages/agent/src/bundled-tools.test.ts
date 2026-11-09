/**
 * Two things are being tested here, and they are worth keeping apart.
 *
 * The first half is the PATH arithmetic: pure, fast, and true regardless of
 * what is on the machine.
 *
 * The second half is the claim that actually matters, and it needs the real
 * binaries: that with the network refused and nothing on PATH, pi's `grep` and
 * `find` still return results. That is the failure this whole change exists to
 * remove, and asserting it against a stub would assert nothing.
 */
import { execFileSync } from "node:child_process";
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

import { afterEach, describe, expect, it } from "vitest";

import { useBundledTools, useScriptRuntime } from "./bundled-tools.js";
import { childProcessEnv, childProcessEnvFor } from "./child-env.js";

/** Pinned by scripts/download-tools.js; asserted here so a bump has to be deliberate. */
const RIPGREP_VERSION = "15.2.0";
const FD_VERSION = "10.3.0";

const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bundled-tools-"));
  scratch.push(dir);

  return dir;
}

afterEach(() => {
  while (scratch.length > 0)
    rmSync(scratch.pop() as string, { recursive: true, force: true });
});

describe("useBundledTools", () => {
  it("does nothing when the app shipped no binaries", () => {
    const env = { PATH: "/usr/bin" };

    expect(useBundledTools(env, join(tempDir(), "absent"))).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("appends rather than prepends, so a user's own rg still wins", () => {
    const dir = tempDir();
    const env = { PATH: `/usr/local/bin${delimiter}/usr/bin` };

    expect(useBundledTools(env, dir)).toBe(true);
    expect(env.PATH?.split(delimiter)).toEqual([
      "/usr/local/bin",
      "/usr/bin",
      dir,
    ]);
  });

  it("does not grow PATH when called again in an inherited environment", () => {
    const dir = tempDir();
    const env = { PATH: "/usr/bin" };

    useBundledTools(env, dir);
    const once = env.PATH;
    useBundledTools(env, dir);

    expect(env.PATH).toBe(once);
  });

  it("handles an environment with no PATH at all", () => {
    const dir = tempDir();
    const env: NodeJS.ProcessEnv = {};

    expect(useBundledTools(env, dir)).toBe(true);
    expect(env.PATH).toBe(dir);
  });
});

describe("useScriptRuntime", () => {
  it("names the app's own Node and puts the libraries first on NODE_PATH, once", () => {
    const dir = tempDir();
    const env: NodeJS.ProcessEnv = { NODE_PATH: "/elsewhere" };
    const launcher = "C:/Home/node/abc/node";

    expect(useScriptRuntime(env, dir, launcher)).toBe(true);
    useScriptRuntime(env, dir, launcher);

    expect(env.ABACUSAI_BOT_NODE).toBe("C:/Home/node/abc/node");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_PATH?.split(delimiter)).toEqual([dir, "/elsewhere"]);
  });

  it("does nothing when the libraries were not built or there is no launcher", () => {
    const env: NodeJS.ProcessEnv = {};

    expect(useScriptRuntime(env, join(tempDir(), "absent"))).toBe(false);
    expect(useScriptRuntime(env, tempDir(), null)).toBe(false);
    expect(env).toEqual({});
  });

  it.skipIf(process.platform === "win32")(
    "runs this process's executable as Node, telling only that run so",
    () => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
      expect(useScriptRuntime(env, tempDir())).toBe(true);

      const command = [
        `"$ABACUSAI_BOT_NODE" -e 'console.log(process.env.ELECTRON_RUN_AS_NODE)'`,
        "echo ${ELECTRON_RUN_AS_NODE:-unset}",
      ].join("; ");
      expect(
        execFileSync("/bin/sh", ["-c", command], {
          env: childProcessEnv(env),
          encoding: "utf8",
        })
      ).toBe("1\nunset\n");
    }
  );

  it("lets a script the agent writes require the bundled libraries", () => {
    const dir = tempDir();
    const script = join(dir, "check.cjs");
    writeFileSync(
      script,
      'const { Document } = require("docx"); const ExcelJS = require("exceljs");' +
        ' const mammoth = require("mammoth"); const JSZip = require("jszip");' +
        " console.log([Document, ExcelJS.Workbook, mammoth.extractRawText, JSZip].map((x) => typeof x).join());"
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The built bundles, as they ship: dist/ beside this source.
    const built = fileURLToPath(new URL("../dist/modules", import.meta.url));
    expect(useScriptRuntime(env, built)).toBe(true);

    expect(
      execFileSync(process.execPath, [script], { env, encoding: "utf8" }).trim()
    ).toBe("function,function,function,function");
  });
});

describe("childProcessEnv on Windows", () => {
  const UTF8 = { PYTHONIOENCODING: "utf-8" };
  const win = (base: NodeJS.ProcessEnv, ...overrides: NodeJS.ProcessEnv[]) =>
    childProcessEnvFor("win32", base, ...overrides);

  it("names the path variable PATH when Windows spells it Path", () => {
    expect(win({ Path: "C:\\user" })).toEqual({ PATH: "C:\\user", ...UTF8 });
  });

  it("keeps a PATH that is already spelled PATH", () => {
    expect(win({ PATH: "C:\\user" })).toEqual({ PATH: "C:\\user", ...UTF8 });
  });

  it("folds both spellings into one, keeping the one spawn would", () => {
    const env = win({ Path: "C:\\user", PATH: "C:\\vendor" });

    expect(Object.keys(env)).toEqual(["PATH", "PYTHONIOENCODING"]);
    // Spawn keeps the first in sorted order, and `PATH` sorts before `Path`.
    expect(env.PATH).toBe("C:\\vendor");
  });

  it("lets an override win over the base, whatever its case", () => {
    expect(win({ Path: "C:\\user" }, { PATH: "C:\\mine" })).toEqual({
      PATH: "C:\\mine",
      ...UTF8,
    });
    expect(win({ PATH: "C:\\user" }, { path: "C:\\mine" })).toEqual({
      PATH: "C:\\mine",
      ...UTF8,
    });
    expect(win({ ComSpec: "cmd.exe" }, { COMSPEC: "other.exe" })).toEqual({
      ComSpec: "other.exe",
      ...UTF8,
    });
  });

  it("drops non-string values, and an undefined override unsets any spelling", () => {
    expect(
      win(
        { Path: "C:\\user", EMPTY: undefined, TEMP: "C:\\tmp" },
        {
          temp: undefined,
        }
      )
    ).toEqual({ PATH: "C:\\user", ...UTF8 });
  });

  it("adds no PATH when there is none", () => {
    expect(win({ HOME: "C:\\home" }, { EXTRA: "1" })).toEqual({
      HOME: "C:\\home",
      EXTRA: "1",
      ...UTF8,
    });
  });

  it("gives Python UTF-8 stdio unless a value is already set", () => {
    expect(win({}).PYTHONIOENCODING).toBe("utf-8");
    expect(win({ PythonIOEncoding: "latin-1" })).toEqual({
      PythonIOEncoding: "latin-1",
    });
    expect(win({}, { PYTHONIOENCODING: "utf-16" }).PYTHONIOENCODING).toBe(
      "utf-16"
    );
    expect(win({}).PYTHONUTF8).toBeUndefined();
  });

  it("drops Electron's own variables in any case, unless an override sets one", () => {
    const base = {
      electron_run_as_node: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      HOME: "C:\\home",
    };

    expect(win(base)).toEqual({ HOME: "C:\\home", ...UTF8 });
    expect(win(base, { ELECTRON_RUN_AS_NODE: "1" })).toEqual({
      HOME: "C:\\home",
      ELECTRON_RUN_AS_NODE: "1",
      ...UTF8,
    });
  });

  it("leaves the base untouched", () => {
    const base = { Path: "C:\\user" };

    win(base, { PATH: "C:\\mine" });

    expect(base).toEqual({ Path: "C:\\user" });
  });
});

describe("childProcessEnv elsewhere", () => {
  it("is a plain copy with the overrides on top", () => {
    expect(
      childProcessEnvFor(
        "linux",
        { PATH: "/usr/bin", Path: "kept", GONE: undefined, DROP: "x" },
        { HOME: "/home/me", DROP: undefined }
      )
    ).toEqual({ PATH: "/usr/bin", Path: "kept", HOME: "/home/me" });
  });

  it("drops Electron's own variables, unless an override sets one", () => {
    const base = {
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      HOME: "/home/me",
    };

    expect(childProcessEnvFor("darwin", base)).toEqual({ HOME: "/home/me" });
    expect(
      childProcessEnvFor("linux", base, { ELECTRON_RUN_AS_NODE: "1" })
    ).toEqual({ HOME: "/home/me", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("sets no Python encoding off Windows", () => {
    expect(childProcessEnvFor("darwin", {}).PYTHONIOENCODING).toBeUndefined();
    expect(childProcessEnvFor("linux", {}).PYTHONIOENCODING).toBeUndefined();
  });

  it("defaults to this process's environment", () => {
    const env = childProcessEnv();

    expect(env.PATH).toBe(process.env.PATH);
    expect(
      Object.keys(env).filter((key) => key.toUpperCase() === "PATH")
    ).toEqual(process.env.PATH != null ? ["PATH"] : []);
  });
});

/**
 * Where the build puts them (scripts/download-tools.js). Present only after that
 * has run, which is part of `npm run build` rather than of `npm test`.
 *
 * Skipping locally is a convenience for a contributor who has only ever run the
 * tests. On CI it is a bug: a suite that quietly stops checking the thing it
 * was written for is worse than one that is red, so there it fails instead.
 */
const shipped = fileURLToPath(new URL("../vendor", import.meta.url));
const exe = process.platform === "win32" ? ".exe" : "";
const haveBinaries = existsSync(join(shipped, `rg${exe}`));

if (!haveBinaries && process.env.CI) {
  throw new Error(
    `No search binaries in ${shipped}. CI must run \`node scripts/download-tools.js\` before ` +
      `\`npm test\`, or this file stops testing anything.`
  );
}

describe.skipIf(!haveBinaries)(
  "the shipped binaries, with the network refused",
  () => {
    it("are executable, and are the versions that were pinned", () => {
      for (const [tool, expected] of [
        ["rg", `ripgrep ${RIPGREP_VERSION}`],
        ["fd", `fd ${FD_VERSION}`],
      ] as const) {
        expect(
          execFileSync(join(shipped, tool + exe), ["--version"], {
            encoding: "utf8",
          })
        ).toContain(expected);
      }
    });

    /**
     * The real claim, run through pi's own tool definitions rather than a
     * reimplementation of them.
     *
     * Three things are taken away at once, because any one of them left in would
     * let the test pass without the binaries we ship:
     *
     *   - HOME, so pi's managed binary directory (`~/.pi/agent/bin`) is empty.
     *     Otherwise any machine that has ever run the agent before passes.
     *   - PATH, down to the shipped directory alone. Otherwise a system rg answers.
     *   - the network, via pi's own PI_OFFLINE switch, so a miss cannot be papered
     *     over by a download.
     *
     * In a child process because pi reads its managed directory once, at import
     * time: HOME has to be set before the module loads.
     */
    function search(
      tool: "grep" | "find",
      args: Record<string, unknown>
    ): string {
      const home = tempDir();
      const workspace = tempDir();

      writeFileSync(
        join(workspace, "hay.txt"),
        "nothing\nthe needle is here\nnothing\n"
      );
      mkdirSync(join(workspace, "nested"));
      writeFileSync(
        join(workspace, "nested", "findable.ts"),
        "export const x = 1\n"
      );

      const factory =
        tool === "grep"
          ? "createGrepToolDefinition"
          : "createFindToolDefinition";
      const script = `
      import { ${factory} } from '@earendil-works/pi-coding-agent'
      const tool = ${factory}(${JSON.stringify(workspace)})
      const result = await tool.execute('test', ${JSON.stringify(args)}, undefined)
      process.stdout.write((result.content ?? []).map((part) => part.text ?? '').join(''))
    `;

      return execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          // Resolves the pi package; the tools are pointed at the workspace by
          // argument, which is how the agent uses them too.
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            HOME: home,
            USERPROFILE: home,
            PI_OFFLINE: "1",
            PATH: shipped,
          },
        }
      );
    }

    it("grep finds a match with no rg anywhere but the shipped directory", () => {
      expect(search("grep", { pattern: "needle" })).toContain(
        "the needle is here"
      );
    });

    it("find matches a glob with no fd anywhere but the shipped directory", () => {
      expect(search("find", { pattern: "**/*.ts" })).toContain("findable.ts");
    });
  }
);
