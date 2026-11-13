/**
 * The one test over a real `fs.watch` (the rest inject a fake, see
 * tables.test.ts). Kept in the `main-serial` project: FSEvents start late and
 * that stretches under the parallel `main` project's load.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { MemoryWatcher } from "./memories";

it("a real fs.watch sees a change recorded in a new history directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-fs-"));
  const changes = vi.fn();
  const watcher = new MemoryWatcher({ home, onChange: changes });
  try {
    const history = path.join(home, "memory", ".history");
    fs.mkdirSync(history, { recursive: true });
    await vi.waitFor(() => expect(watcher.watchedPath()).toBe(history), {
      timeout: 15_000,
      interval: 50,
    });
    changes.mockClear();
    // Keep appending until one lands: the watcher may start after the first.
    await vi.waitFor(
      () => {
        fs.appendFileSync(path.join(history, "2026-11.jsonl"), "{}\n");
        expect(changes).toHaveBeenCalled();
      },
      { timeout: 15_000, interval: 250 }
    );
  } finally {
    watcher.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 40_000);
