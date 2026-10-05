import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  readlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { trashItem, sweepTrash } from "./filesystem";
it("trashes files, directories and symlinks across mounts without dereferencing", async () => {
  const home = await mkdtemp(join(tmpdir(), "trash-home-"));
  const source = await mkdtemp("/dev/shm/trash-source-");
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
  try {
    await writeFile(join(source, "file"), "kept");
    await mkdir(join(source, "dir"));
    await writeFile(join(source, "dir/nested"), "nested");
    await symlink("missing", join(source, "link"));
    for (const name of ["file", "dir", "link"])
      await trashItem(join(source, name));
    expect(await readdir(source)).toEqual([]);
    const dir = join(home, "trash", new Date().toISOString().slice(0, 10));
    const names = await readdir(dir);
    expect(
      await readFile(
        join(
          dir,
          names.find((n) => n.endsWith("-file"))!
        ),
        "utf8"
      )
    ).toBe("kept");
    expect(
      await readFile(
        join(
          dir,
          names.find((n) => n.endsWith("-dir"))!,
          "nested"
        ),
        "utf8"
      )
    ).toBe("nested");
    expect(
      await readlink(
        join(
          dir,
          names.find((n) => n.endsWith("-link"))!
        )
      )
    ).toBe("missing");
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

it("retains the source and removes a partial trash copy when copying fails", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "trash-failure-"));
  const source = await mkdtemp("/dev/shm/trash-failure-");
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
  try {
    await writeFile(join(source, "keep.txt"), "original");
    execFileSync("mkfifo", [join(source, "unsupported-fifo")]);
    await expect(trashItem(source)).rejects.toThrow();
    expect(await readFile(join(source, "keep.txt"), "utf8")).toBe("original");
    expect(
      await readdir(join(home, "trash", new Date().toISOString().slice(0, 10)))
    ).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

it("logs a broken trash entry and continues sweeping", async () => {
  const home = await mkdtemp(join(tmpdir(), "trash-sweep-"));
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await mkdir(join(home, "trash"));
    await symlink("missing", join(home, "trash/broken"));
    await writeFile(join(home, "trash/old"), "expired");
    const { utimes } = await import("node:fs/promises");
    await utimes(join(home, "trash/old"), 0, 0);
    await expect(sweepTrash()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[host-trash] sweep entry failed",
      join(home, "trash/broken"),
      expect.any(Error)
    );
    expect(await readdir(join(home, "trash"))).toEqual(["broken"]);
  } finally {
    vi.unstubAllEnvs();
    warn.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});
