import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { installPosixShell } from "./posix-shell-install.js";
import { posixShellOperations } from "./posix-shell.js";

const payload = fileURLToPath(
  new URL("../vendor/busybox.exe", import.meta.url)
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
