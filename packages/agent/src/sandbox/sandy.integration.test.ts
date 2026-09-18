import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

import { expect, it } from "vitest";

import { installPosixShell, posixShellEnv } from "../posix-shell-install.js";

it.skipIf(process.platform !== "win32" || !existsSync("vendor/sandy.exe"))(
  "runs BusyBox and Git in Sandy without allowing outside writes",
  () => {
    const root = mkdtempSync(join(homedir(), "sandy-busybox-"));
    mkdirSync(join(root, "workspace"));
    const cwd = realpathSync.native(join(root, "workspace"));
    const mount = spawnSync("C:/Windows/System32/subst.exe", ["Z:", cwd], {
      encoding: "utf8",
    });
    expect(mount.status, mount.stderr).toBe(0);
    try {
      const shell = installPosixShell({
        payload: resolve("vendor/busybox.exe"),
        cacheRoot: join(root, "shell"),
      })!;
      const parents: string[] = [];
      for (
        let parent = dirname(cwd);
        parent.toLowerCase().startsWith(homedir().toLowerCase());
        parent = dirname(parent)
      ) {
        parents.push(parent);
        if (parent === dirname(parent)) break;
      }
      const config = `[sandbox]\ntoken = 'appcontainer'\nworkdir = "Z:\\\\"\n[allow.deep]\nexecute = [${JSON.stringify(shell.bin)}]\nall = [${JSON.stringify(cwd)}]\n[allow.this]\nread = ${JSON.stringify(parents)}\n[environment]\ninherit = true\n[privileges]\nnetwork = false\nlan = false\n`;
      const command = `echo content | cat > file.txt && git init && git add file.txt && git -c user.name=Test -c user.email=test@example.com commit -m test && git status --porcelain; echo outside > '${join(root, "denied.txt").replaceAll("\\", "/")}'`;
      const result = spawnSync(
        resolve("vendor/sandy.exe"),
        ["-s", config, "-x", shell.sh, "-c", command],
        {
          env: posixShellEnv(
            { ...process.env, GIT_CONFIG_GLOBAL: "NUL" },
            shell
          ),
          encoding: "utf8",
          timeout: 30000,
        }
      );
      expect(result.error).toBeUndefined();
      expect(
        existsSync(join(cwd, "file.txt")),
        `${result.status}: ${result.stdout}${result.stderr}`
      ).toBe(true);
      expect(
        existsSync(join(cwd, ".git", "HEAD")),
        `${result.status}: ${result.stdout}${result.stderr}`
      ).toBe(true);
      expect(
        existsSync(join(root, "denied.txt")),
        `${result.status}: ${result.stdout}${result.stderr}`
      ).toBe(false);
    } finally {
      spawnSync("C:/Windows/System32/subst.exe", ["Z:", "/D"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000
);
