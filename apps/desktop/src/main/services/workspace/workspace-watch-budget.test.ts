import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canAffordRecursiveWatch } from "./workspace-runtime-service";

/**
 * The recursive-watch budget is what keeps a pathological workspace (the
 * home directory being the canonical case, registered by onboarding) from
 * freezing the whole app while Node's Linux recursive-watch emulation walks
 * it on the event loop.
 */
const makeTree = async (depth: number, fanout: number): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "watch-budget-"));
  const grow = async (parent: string, level: number): Promise<void> => {
    if (level === 0) {
      return;
    }

    for (let index = 0; index < fanout; index += 1) {
      const child = path.join(parent, `d${level}-${index}`);

      await fs.mkdir(child);
      await grow(child, level - 1);
    }
  };

  await grow(root, depth);

  return root;
};

describe("canAffordRecursiveWatch", () => {
  it("allows a small tree", async () => {
    const root = await makeTree(2, 2);

    try {
      await expect(canAffordRecursiveWatch(root, 100)).resolves.toBe(true);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("refuses a tree over the directory budget", async () => {
    const root = await makeTree(2, 4);

    try {
      // 1 root + 4 + 16 nested directories against a budget of 10.
      await expect(canAffordRecursiveWatch(root, 10)).resolves.toBe(false);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("refuses the home directory outright, whatever the budget", async () => {
    const home = await makeTree(1, 1);

    try {
      await expect(
        canAffordRecursiveWatch(home, 1_000_000, home)
      ).resolves.toBe(false);
    } finally {
      await fs.rm(home, { force: true, recursive: true });
    }
  });

  it("refuses any root that contains the home directory", async () => {
    const root = await makeTree(1, 1);
    const home = path.join(root, "d1-0");

    try {
      await expect(
        canAffordRecursiveWatch(root, 1_000_000, home)
      ).resolves.toBe(false);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("does not follow directory symlinks while counting", async () => {
    const root = await makeTree(1, 2);

    try {
      // A cycle: without the symlink guard the walk would never finish.
      await fs.symlink(root, path.join(root, "d1-0", "loop"), "dir");
      await expect(canAffordRecursiveWatch(root, 100)).resolves.toBe(true);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });
});
