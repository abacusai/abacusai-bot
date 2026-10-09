import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  outsideScope,
  pathsNamedIn,
  shellPathOperands,
  type TaskScope,
  taskScope,
} from "./scope-guard.js";

// A machine of our own: a home with the task's project and another checkout
// beside it, a temp folder, and a system folder outside home.
const base = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "scope-guard-"))
);
const home = path.join(base, "home");
const project = path.join(home, "session", "n8n");
const otherCheckout = path.join(home, "Documents", "New project", "n8n");
const temp = path.join(base, "temp");
const system = path.join(base, "usr");
for (const dir of [project, otherCheckout, temp, system])
  fs.mkdirSync(dir, { recursive: true });

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const scope = (task = "", allowed: string[] = []): TaskScope =>
  taskScope(project, task, allowed, { home, temp });

describe("what a sub-agent may reach", () => {
  it("keeps everything inside its root", () => {
    expect(outsideScope("packages/core/src/a.ts", project, scope())).toBe(
      false
    );
    expect(outsideScope(project, project, scope())).toBe(false);
  });

  it("refuses another checkout elsewhere in home", () => {
    expect(
      outsideScope(path.join(otherCheckout, "package.json"), project, scope())
    ).toBe(true);
  });

  it("refuses climbing out of the root", () => {
    expect(outsideScope("../poster.html", project, scope())).toBe(true);
  });

  it("refuses a search that starts at or above home", () => {
    expect(outsideScope("/", project, scope())).toBe(true);
    expect(outsideScope(home, project, scope())).toBe(true);
    expect(outsideScope(base, project, scope())).toBe(true);
  });

  it("allows a path the task names, and its skill folders", () => {
    const named = path.join(home, "Downloads", "brief.pdf");
    const skills = path.join(home, ".abacusai-bot", "skills");

    expect(outsideScope(named, project, scope(`Summarise ${named}.`))).toBe(
      false
    );
    expect(
      outsideScope(
        path.join(skills, "pdf", "SKILL.md"),
        project,
        scope("", [skills])
      )
    ).toBe(false);
  });

  it("allows temp and system folders outside home", () => {
    expect(outsideScope(path.join(temp, "x.log"), project, scope())).toBe(
      false
    );
    expect(
      outsideScope(path.join(system, "bin", "node"), project, scope())
    ).toBe(false);
  });

  // Windows needs a privilege to make a symlink.
  it.skipIf(process.platform === "win32")(
    "judges a link by where it lands",
    () => {
      const link = path.join(project, "elsewhere");
      fs.symlinkSync(otherCheckout, link);

      expect(outsideScope("elsewhere/package.json", project, scope())).toBe(
        true
      );
    }
  );
});

describe("reading paths out of a task", () => {
  it("finds absolute and ~/ paths, without trailing punctuation", () => {
    expect(pathsNamedIn("Read /a/b.ts, then ~/c/d.md.")).toEqual([
      path.resolve("/a/b.ts"),
      path.join(os.homedir(), "c/d.md"),
    ]);
  });

  it("ignores slashes inside words and URLs", () => {
    expect(pathsNamedIn("and/or, https://x.dev/a, 3/4")).toEqual([]);
  });
});

describe("reading paths out of a shell command", () => {
  it("takes absolute, home and climbing operands, not the verb", () => {
    expect(
      shellPathOperands(
        '/usr/bin/find / -maxdepth 4 -name "expression-runtime" 2>/dev/null'
      )
    ).toEqual(["/", "/dev/null"]);
    expect(shellPathOperands("ls ~ && cat $HOME/.zshrc ../x")).toEqual([
      "~",
      "~/.zshrc",
      "../x",
    ]);
  });

  it("reads a --flag=/path value", () => {
    expect(shellPathOperands("rg foo --glob=x --path=/opt/a")).toEqual([
      "/opt/a",
    ]);
  });

  it("leaves relative paths and URLs alone", () => {
    expect(
      shellPathOperands("git clone https://github.com/n8n-io/n8n && ls src")
    ).toEqual([]);
  });
});
