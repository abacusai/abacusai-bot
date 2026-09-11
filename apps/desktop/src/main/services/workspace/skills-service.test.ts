/**
 * openFile is "double-click this file": it must only reach paths inside a
 * skills directory, the same boundary remove() enforces.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const openPath = vi.fn(async (_target: string) => "");
const showItemInFolder = vi.fn((_target: string) => {});
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  shell: {
    openPath: (p: string) => openPath(p),
    showItemInFolder: (p: string) => showItemInFolder(p),
  },
}));

let home: string;
let workspace: string;
let skillsService: typeof import("./skills-service").SkillsService.prototype;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skills-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skills-ws-"));
  // The skills roots are derived from ABACUSAI_BOT_HOME at module load, so the
  // env must be in place before the service is imported.
  process.env.ABACUSAI_BOT_HOME = home;
  const { SkillsService } = await import("./skills-service");
  skillsService = new SkillsService();

  fs.mkdirSync(path.join(home, "skills"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "greet.md"), "# greet");
  fs.mkdirSync(path.join(workspace, ".abacusai-bot", "skills"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workspace, ".abacusai-bot", "skills", "local.md"),
    "# local"
  );
  fs.writeFileSync(path.join(workspace, "README.md"), "not a skill");
});

afterAll(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("SkillsService.openFile", () => {
  it("opens a global skill", async () => {
    const res = await skillsService.openFile({
      path: path.join(home, "skills", "greet.md"),
    });
    expect(res.success).toBe(true);
    // The resolved path, which is what the decision was made about.
    expect(openPath).toHaveBeenCalledWith(
      fs.realpathSync(path.join(home, "skills", "greet.md"))
    );
  });

  it("reveals a helper the OS would run, rather than claiming it is outside", () => {
    // The boundary is satisfied — it is a file in a skills directory — so a
    // message about being outside one would simply be untrue, and the click
    // must still take the user to the file.
    // "Something the OS would run" is the executable bit on POSIX and the
    // extension on Windows, where an extensionless `setup` is just a file.
    const helper = path.join(
      home,
      "skills",
      process.platform === "win32" ? "setup.cmd" : "setup"
    );
    fs.writeFileSync(helper, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    return skillsService.openFile({ path: helper }).then((res) => {
      expect(res.success).toBe(true);
      expect(openPath).not.toHaveBeenCalledWith(helper);
      expect(showItemInFolder).toHaveBeenCalledWith(fs.realpathSync(helper));
      fs.rmSync(helper, { force: true });
    });
  });

  it("opens a project skill when the workspace is named", async () => {
    const res = await skillsService.openFile({
      path: path.join(workspace, ".abacusai-bot", "skills", "local.md"),
      workspacePath: workspace,
    });
    expect(res.success).toBe(true);
  });

  it("refuses a project-skill path when no workspace is named", async () => {
    openPath.mockClear();
    const res = await skillsService.openFile({
      path: path.join(workspace, ".abacusai-bot", "skills", "local.md"),
    });
    expect(res.success).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
  });

  it("refuses paths outside the skills directories", async () => {
    openPath.mockClear();
    for (const target of [
      path.join(workspace, "README.md"),
      path.join(home, "..", "elsewhere.txt"),
      "/etc/hosts",
    ]) {
      const res = await skillsService.openFile({
        path: target,
        workspacePath: workspace,
      });
      expect(res.success).toBe(false);
    }
    expect(openPath).not.toHaveBeenCalled();
  });
});
