import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cmdCommandLine,
  resolveSpawn,
  resolveWin32Command,
} from "./windows-spawn.js";

/** A fake PATH directory holding the shims a Windows npm install produces. */
let bin: string;

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "win-spawn-test-"));
  // `npx` is the extensionless POSIX script npm really does install beside
  // `npx.cmd` on Windows; `plain` has no executable twin at all.
  for (const name of ["npx", "npx.cmd", "uvx.EXE", "plain"]) {
    fs.writeFileSync(path.join(bin, name), "");
  }
  fs.mkdirSync(path.join(bin, "ghost.CMD")); // a directory must never win
});

afterAll(() => {
  fs.rmSync(bin, { recursive: true, force: true });
});

const PATHEXT = ".COM;.EXE;.BAT;.CMD";

describe("resolving a command the way cmd.exe would", () => {
  it("finds a .cmd shim through PATHEXT", () => {
    expect(resolveWin32Command("npx", bin, PATHEXT)).toBe(
      path.join(bin, "npx.cmd")
    );
  });

  it("matches extensions case-insensitively, like Windows", () => {
    expect(resolveWin32Command("uvx", bin, PATHEXT)).toBe(
      path.join(bin, "uvx.EXE")
    );
    expect(resolveWin32Command("UVX", bin, PATHEXT)).toBe(
      path.join(bin, "uvx.EXE")
    );
  });

  it("prefers the .cmd shim over its extensionless POSIX twin", () => {
    // Both files exist in a real Windows npm bin directory. Windows cannot
    // execute the sh script (error 193), and cmd.exe would never pick it —
    // only PATHEXT extensions count.
    expect(resolveWin32Command("npx", bin, PATHEXT)).toBe(
      path.join(bin, "npx.cmd")
    );
  });

  it("never resolves to a file without an executable extension", () => {
    expect(resolveWin32Command("plain", bin, PATHEXT)).toBeNull();
  });

  it("takes a name that already carries an executable extension verbatim", () => {
    expect(resolveWin32Command("npx.cmd", bin, PATHEXT)).toBe(
      path.join(bin, "npx.cmd")
    );
  });

  it("never lets a directory win the lookup", () => {
    expect(resolveWin32Command("ghost", bin, PATHEXT)).toBeNull();
  });

  it("returns null when nothing on PATH matches", () => {
    expect(resolveWin32Command("no-such-tool", bin, PATHEXT)).toBeNull();
  });

  it("skips PATH for a command given as a path", () => {
    expect(
      resolveWin32Command(path.join(bin, "npx"), "/definitely/absent", PATHEXT)
    ).toBe(path.join(bin, "npx.cmd"));
  });
});

describe("the cmd.exe command line", () => {
  it("quotes every token, doubling embedded quotes", () => {
    expect(
      cmdCommandLine("C:\\Program Files\\nodejs\\npx.cmd", [
        "-y",
        'a "quoted" arg',
        "semi;colon",
      ])
    ).toBe(
      '"C:\\Program Files\\nodejs\\npx.cmd" "-y" "a ""quoted"" arg" "semi;colon"'
    );
  });

  it("doubles trailing backslashes so they cannot escape the closing quote", () => {
    // The child's argv parser reads `\"` as an escaped quote, so an argument
    // ending in `\` would swallow its own closing quote and the next token.
    expect(cmdCommandLine("C:\\t.cmd", ["C:\\dir\\"])).toBe(
      '"C:\\t.cmd" "C:\\dir\\\\"'
    );
    expect(cmdCommandLine("C:\\t.cmd", ["ends\\\\"])).toBe(
      '"C:\\t.cmd" "ends\\\\\\\\"'
    );
  });

  it("doubles the backslashes that sit against an EMBEDDED quote too", () => {
    // Microsoft's rule halves a backslash run whenever it meets a quote, not
    // only at the end of a token — so a JSON argument like {"root":"C:\"}
    // lost a backslash and shifted its own token boundaries.
    expect(cmdCommandLine("C:\\t.cmd", ['{"root":"C:\\"}'])).toBe(
      '"C:\\t.cmd" "{""root"":""C:\\\\""}"'
    );
  });
});

describe("resolveSpawn", () => {
  it("passes through untouched off Windows", () => {
    const spec = resolveSpawn("npx", ["-y", "server"], "darwin", {});
    expect(spec).toEqual({ file: "npx", args: ["-y", "server"] });
  });

  it("wraps a .cmd shim in cmd.exe with a pre-quoted verbatim line", () => {
    const spec = resolveSpawn("npx", ["-y", "server"], "win32", {
      PATH: bin,
      PATHEXT,
    });
    expect(spec.file).toBe("cmd.exe");
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Outer quotes for /s, absolute shim path inside so %~dp0 stays correct.
    expect(spec.args[3]).toBe(`""${path.join(bin, "npx.cmd")}" "-y" "server""`);
  });

  it("spawns a resolved .exe directly, no shell", () => {
    const spec = resolveSpawn("uvx", ["tool"], "win32", {
      PATH: bin,
      PATHEXT,
    });
    expect(spec).toEqual({ file: path.join(bin, "uvx.EXE"), args: ["tool"] });
  });

  it("leaves an unresolvable command for spawn to report", () => {
    const spec = resolveSpawn("absent", [], "win32", { PATH: bin, PATHEXT });
    expect(spec).toEqual({ file: "absent", args: [] });
  });

  it("expands a defined %VAR% itself, leaving cmd nothing to expand", () => {
    // `%USERPROFILE%\Documents` is the standard idiom in a Windows MCP config
    // and has to keep working. Substituting the value here is what makes the
    // command line free of anything cmd would rewrite.
    const spec = resolveSpawn(
      "npx",
      ["--out", "%USERPROFILE%\\Docs"],
      "win32",
      {
        PATH: bin,
        PATHEXT,
        USERPROFILE: "C:\\Users\\me",
      }
    );

    expect(spec.args[3]).toContain('"C:\\Users\\me\\Docs"');
    expect(spec.args[3]).not.toContain("%USERPROFILE%");
  });

  it("matches the variable case-insensitively, as cmd does", () => {
    const spec = resolveSpawn("npx", ["%userprofile%"], "win32", {
      PATH: bin,
      PATHEXT,
      USERPROFILE: "C:\\Users\\me",
    });

    expect(spec.args[3]).toContain('"C:\\Users\\me"');
  });

  it("refuses only when the value would itself be expanded again", () => {
    // Substitution cannot settle this one: cmd would act on the `%` that came
    // out of the value, so there is no command line that passes it literally.
    expect(() =>
      resolveSpawn("npx", ["%ODD%"], "win32", {
        PATH: bin,
        PATHEXT,
        ODD: "50%PATH%",
      })
    ).toThrow(/%ODD%/);
  });

  it("passes an undefined %name% through — cmd leaves those literal", () => {
    const spec = resolveSpawn("npx", ["100%%pure%"], "win32", {
      PATH: bin,
      PATHEXT,
    });
    expect(spec.file).toBe("cmd.exe");
    expect(spec.args[3]).toContain("100%%pure%");
  });
});
