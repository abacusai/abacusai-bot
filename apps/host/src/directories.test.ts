import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { listDirectory, makeDirectory } from "./directories";

const userHome = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => userHome.path,
}));

it.each([true, false])(
  "clamps picker paths with bot home inside user home=%s",
  async (nested) => {
    const sandbox = await mkdtemp(join(tmpdir(), "host-picker-"));
    userHome.path = join(sandbox, "user-home");
    const root = join(nested ? userHome.path : sandbox, "abacus-bot");
    const allowedRoot = nested ? userHome.path : root;
    const outside = join(sandbox, "outside");
    await mkdir(userHome.path);
    await mkdir(root);
    await mkdir(outside);
    vi.stubEnv("ABACUSAI_BOT_HOME", root);
    try {
      const home = join(root, "bot-home");
      await mkdir(home);
      await mkdir(join(home, "empty"));
      await writeFile(join(home, "Résumé notes.txt"), "notes");
      await symlink(
        outside,
        join(home, "outside"),
        process.platform === "win32" ? "junction" : "dir"
      );
      const listing = await listDirectory();
      expect(listing.root).toBe(await realpath(allowedRoot));
      expect(listing.entries.map((entry) => entry.name)).toEqual([
        "empty",
        "Résumé notes.txt",
      ]);
      expect((await listDirectory(join(home, "empty"))).entries).toEqual([]);
      await expect(listDirectory(join(home, "outside"))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(listDirectory(outside)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(listDirectory(join(home, "missing"))).rejects.toMatchObject({
        code: "CONFLICT",
      });
      for (const name of ["..", "../escape", "a/b", "a\\b", ""])
        await expect(makeDirectory(home, name)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      const created = await makeDirectory(home, "New workspace");
      expect((await listDirectory(created.path)).entries).toEqual([]);
      await expect(makeDirectory(home, "New workspace")).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(sandbox, { recursive: true, force: true });
    }
  }
);
