/**
 * The one test over a real `fs.watch` (the rest inject a fake, see
 * tables.test.ts). Kept in the `main-serial` project: FSEvents start late and
 * that stretches under the parallel `main` project's load.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { MemoryWatchers } from "./memories";

it("a real fs.watch sees a write in a new directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-fs-"));
  const changes = vi.fn();
  const watchers = new MemoryWatchers({ home, onChange: changes });
  try {
    const memories = path.join(home, "memories");
    fs.mkdirSync(memories);
    await vi.waitFor(
      () => expect(watchers.watchedPaths()).toContain(memories),
      {
        timeout: 15_000,
        interval: 50,
      }
    );
    changes.mockClear();
    // Keep writing until one lands: the watcher may start after the first.
    let n = 0;
    await vi.waitFor(
      () => {
        fs.writeFileSync(path.join(memories, "MEMORY.md"), `note ${n++}`);
        expect(changes).toHaveBeenCalled();
      },
      { timeout: 15_000, interval: 250 }
    );
  } finally {
    watchers.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 40_000);
