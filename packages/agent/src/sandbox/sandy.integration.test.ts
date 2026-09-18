import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { installPosixShell, posixShellEnv } from "../posix-shell-install.js";

// Draft compatibility experiment, not the app's execution path yet. Git's
// normalized-path lookup fails through inaccessible ancestors in AppContainer;
// a drive alias avoids that lookup. Production integration still needs a
// lifecycle for these aliases and normal user Git configuration access.

it.skipIf(process.platform !== "win32" || !existsSync("vendor/sandy.exe"))(
  "runs BusyBox and Git in Sandy without allowing outside writes",
  () => {
    const root = mkdtempSync(join(homedir(), "sandy-busybox-"));
    mkdirSync(join(root, "workspace"));
    const cwd = realpathSync.native(join(root, "workspace"));
    const subst = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "subst.exe"
    );
    let drive: string | undefined;
    try {
      for (const letter of "ZYXWVUTSRQPONMLKJIHGFE") {
        const candidate = `${letter}:`;
        const mount = spawnSync(subst, [candidate, cwd], {
          encoding: "utf8",
          timeout: 5000,
        });
        if (mount.status === 0) {
          drive = candidate;
          break;
        }
      }
      if (drive == null)
        throw new Error("No unused drive letter for Sandy compatibility test");
      const shell = installPosixShell({
        payload: resolve("vendor/busybox.exe"),
        cacheRoot: join(root, "shell"),
      })!;
      const config = `[sandbox]\ntoken = 'appcontainer'\nworkdir = ${JSON.stringify(`${drive}\\`)}\n[allow.deep]\nexecute = [${JSON.stringify(shell.bin)}]\nall = [${JSON.stringify(cwd)}]\n[environment]\ninherit = true\n[privileges]\nnetwork = true\nlan = false\n`;
      const command = `echo content | cat > file.txt && git init && git add file.txt && git -c user.name=Test -c user.email=test@example.com commit -m test && git status --porcelain && echo git-write-ok; echo outside > '${join(root, "denied.txt").replaceAll("\\", "/")}'`;
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
      expect(result.stdout, result.stderr).toContain("git-write-ok");
      expect(result.status).toBe(1);
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
      if (drive != null) spawnSync(subst, [drive, "/D"], { timeout: 5000 });
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000
);
