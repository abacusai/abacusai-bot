/**
 * The desktop half of the store the app and the CLI share.
 *
 * The shared core is covered in packages/agent/src/memory-store.test.ts. What
 * is only here is the UI's own entry points — and the reason they matter is
 * that they run on the process that draws every window, alongside an agent
 * session writing the same two files.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMemoryAction, forgetAll, listMemories } from "./memory-store";

/** A lock held by this process, which is unambiguously still running. */
const holding = (): string => `${os.hostname()}:${process.pid}:holding`;

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-memory-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

describe("clearing a store from the memory panel", () => {
  it("empties it", async () => {
    await applyMemoryAction("memory", "add", { content: "Something old." });

    const result = await forgetAll("memory");

    expect(result.ok).toBe(true);
    expect(listMemories().memory).toEqual([]);
  });

  it("takes the same lock every other write takes", async () => {
    // Without it, "Forget all" races a session's `memory add`: the add read the
    // entries before the clear and writes them straight back afterwards. The
    // holder here is this process, which is unambiguously still running.
    const lock = path.join(home, "memories", "MEMORY.md.lock");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, holding(), "utf8");

    const result = await forgetAll("memory");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("nothing was changed");
  }, 30_000);

  it("leaves the process free to do other work while it waits", async () => {
    // The wait runs on the Electron main process; a blocking sleep there stops
    // every window, every IPC message and every session's streaming until the
    // contention clears.
    const lock = path.join(home, "memories", "MEMORY.md.lock");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, holding(), "utf8");

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 50);

    try {
      expect((await forgetAll("memory")).ok).toBe(false);
    } finally {
      clearInterval(ticker);
    }

    // Timers kept firing throughout the wait; under a blocking sleep none of
    // them would have.
    expect(ticks).toBeGreaterThan(5);
  }, 30_000);
});

/**
 * The two copies of this store, compared where they must not drift.
 *
 * The whole file cannot be diffed — the desktop copy carries the UI's own entry
 * points and the messages are worded per surface — but the locking is not a
 * per-surface concern: it is one protocol two processes speak to each other
 * through a file on disk. A fix applied to one copy and not the other leaves
 * the app and the terminal disagreeing about when a lock may be broken, which
 * is the one disagreement that loses an entry silently.
 */
describe("the locking shared with the agent package's copy", () => {
  const START = "// ── shared lock — keep byte-identical with the other copy";
  const END = "// ── end shared lock";

  const sharedRegion = (file: string): string => {
    const source = fs.readFileSync(file, "utf8");
    const from = source.indexOf(START);
    const to = source.indexOf(END);

    expect(from, `no shared-lock markers in ${file}`).toBeGreaterThan(-1);
    expect(to, `no shared-lock end marker in ${file}`).toBeGreaterThan(from);

    return source.slice(from, to);
  };

  it("is byte-identical in both", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, "..", "..", "..", "..", "..", "..");

    expect(sharedRegion(path.join(here, "memory-store.ts"))).toBe(
      sharedRegion(
        path.join(root, "packages", "agent", "src", "memory-store.ts")
      )
    );
  });
});
