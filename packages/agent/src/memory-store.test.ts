/**
 * The store the CLI and the desktop share.
 *
 * The regression that matters is silent: a format that drifts from
 * apps/desktop/src/main/services/agent-tools/memory-store.ts does not throw, it
 * just means the terminal cannot read what the app wrote. So the delimiter, the
 * filenames and the block headers are pinned here as literals rather than
 * imported: a test that reads the same constant as the code cannot catch the
 * constant changing.
 */
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyMemoryAction,
  memorySnapshot,
  readEntries,
  rememberSnapshot,
} from "./memory-store.js";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

const write = (file: string, contents: string): void => {
  fs.mkdirSync(path.join(home, "memories"), { recursive: true });
  fs.writeFileSync(path.join(home, "memories", file), contents, "utf8");
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-memory-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

describe("what the agent carries into a session", () => {
  it("says nothing when nothing has been remembered", async () => {
    // A fresh install has no store at all, which is normal and must not throw.
    expect(memorySnapshot()).toBeNull();
  });

  it("reads both stores under the headers the desktop matches on", async () => {
    write("MEMORY.md", "Deploys with `make ship`.\n§\nPins Node 22.");
    write("USER.md", "Prefers terse answers.");

    expect(memorySnapshot()).toBe(
      "MEMORY (your personal notes)\n" +
        "- Deploys with `make ship`.\n" +
        "- Pins Node 22.\n" +
        "\n" +
        "USER PROFILE (who the user is)\n" +
        "- Prefers terse answers."
    );
  });

  it("splits on the section sign, not on blank lines", async () => {
    // Entries are prose and routinely contain blank lines; splitting on those
    // would shatter one memory into several.
    write(
      "MEMORY.md",
      "First line.\n\nStill the first entry.\n§\nSecond entry."
    );

    const snapshot = memorySnapshot();

    expect(snapshot).toContain("- First line.\n\nStill the first entry.");
    expect(snapshot).toContain("- Second entry.");
  });

  it("drops empty entries rather than emitting bare bullets", async () => {
    write("MEMORY.md", "Real entry.\n§\n\n§\n   \n§\nAnother.");

    expect(memorySnapshot()).toBe(
      "MEMORY (your personal notes)\n- Real entry.\n- Another."
    );
  });

  it("omits a store that exists but is empty", async () => {
    write("MEMORY.md", "Only this.");
    write("USER.md", "");

    expect(memorySnapshot()).toBe("MEMORY (your personal notes)\n- Only this.");
  });
});

/**
 * Writing, which the CLI could not do at all until it had its own store: the
 * `memory` tool arrives over MCP, so a terminal session could recall what the
 * desktop had remembered and never add to it.
 *
 * The limits and the wording are asserted because they are the contract the
 * desktop's store already publishes. Drift here does not throw; it just means
 * the same call answers differently depending on which surface made it.
 */
describe("editing what is remembered", () => {
  it("adds an entry and reads it straight back", async () => {
    const result = await applyMemoryAction("memory", "add", {
      content: "Tests run with vitest.",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Remembered.");
    expect(readEntries("memory")).toEqual(["Tests run with vitest."]);
  });

  it("keeps the two stores apart", async () => {
    await applyMemoryAction("memory", "add", {
      content: "The build needs Node 22.",
    });
    await applyMemoryAction("user", "add", {
      content: "Prefers short answers.",
    });

    expect(readEntries("memory")).toEqual(["The build needs Node 22."]);
    expect(readEntries("user")).toEqual(["Prefers short answers."]);
  });

  it("treats an exact duplicate as a no-op rather than an error", async () => {
    await applyMemoryAction("memory", "add", {
      content: "Ports are in config.json.",
    });
    const again = await applyMemoryAction("memory", "add", {
      content: "ports are in CONFIG.JSON.",
    });

    expect(again.ok).toBe(true);
    expect(again.message).toBe("Already remembered, nothing changed.");
    expect(readEntries("memory")).toHaveLength(1);
  });

  it("replaces the one entry a fragment identifies", async () => {
    await applyMemoryAction("memory", "add", {
      content: "The API lives on port 8080.",
    });
    const result = await applyMemoryAction("memory", "replace", {
      match: "port 8080",
      content: "The API lives on port 9090.",
    });

    expect(result.ok).toBe(true);
    expect(readEntries("memory")).toEqual(["The API lives on port 9090."]);
  });

  it("refuses a fragment that matches more than one entry, rather than guessing", async () => {
    await applyMemoryAction("memory", "add", {
      content: "The API lives on port 8080.",
    });
    await applyMemoryAction("memory", "add", {
      content: "The worker lives on port 8081.",
    });

    const result = await applyMemoryAction("memory", "remove", {
      match: "port 80",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("matches 2 entries");
    expect(readEntries("memory")).toHaveLength(2);
  });

  it("reports a fragment that matches nothing", async () => {
    const result = await applyMemoryAction("memory", "remove", {
      match: "nothing like this",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Nothing in memory contains");
  });

  it("forgets an entry", async () => {
    await applyMemoryAction("memory", "add", {
      content: "Stale fact about the old CI.",
    });
    const result = await applyMemoryAction("memory", "remove", {
      match: "old CI",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Forgotten.");
    expect(readEntries("memory")).toEqual([]);
  });

  it("rejects an entry carrying a bare delimiter line, which would split it in two", async () => {
    const result = await applyMemoryAction("memory", "add", {
      content: "first\n§\nsecond",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("reserved as the entry separator");
    expect(readEntries("memory")).toEqual([]);
  });

  it("rejects an entry over the per-entry limit", async () => {
    const result = await applyMemoryAction("memory", "add", {
      content: "x".repeat(2_001),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("the limit is 2000");
  });

  it("writes a format the snapshot reader can read back", async () => {
    await applyMemoryAction("memory", "add", { content: "One." });
    await applyMemoryAction("memory", "add", { content: "Two." });
    await applyMemoryAction("user", "add", { content: "Three." });

    const snapshot = memorySnapshot();

    expect(snapshot).toContain("MEMORY (your personal notes)\n- One.\n- Two.");
    expect(snapshot).toContain("USER PROFILE (who the user is)\n- Three.");
  });

  it("stages every write under its own temp name, and leaves none behind", async () => {
    // The desktop and CLI write these files concurrently. With one fixed
    // `.tmp` name, two writers interleave into the same temp file and the
    // rename publishes the mix.
    const spy = vi.spyOn(fs, "writeFileSync");

    try {
      await applyMemoryAction("memory", "add", { content: "First note." });
      await applyMemoryAction("memory", "add", { content: "Second note." });

      const temps = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((file) => file.endsWith(".tmp"));

      expect(temps).toHaveLength(2);
      expect(new Set(temps).size).toBe(2);
      for (const temp of temps)
        expect(path.basename(temp)).toContain(String(process.pid));
    } finally {
      spy.mockRestore();
    }

    const leftovers = fs
      .readdirSync(path.join(home, "memories"))
      .filter((name) => name.endsWith(".tmp"));

    expect(leftovers).toEqual([]);
  });

  it("leaves no temp file behind when the write itself fails", async () => {
    // The unique temp name means a failing disk drops a fresh orphan on every
    // attempt rather than overwriting one, so the cleanup has to be explicit.
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    try {
      await expect(
        applyMemoryAction("memory", "add", { content: "Doomed." })
      ).rejects.toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }

    const leftovers = fs
      .readdirSync(path.join(home, "memories"))
      .filter((name) => name.endsWith(".tmp"));

    expect(leftovers).toEqual([]);
  });
});

/**
 * Writers in separate processes, which is the only way to reproduce the race:
 * within one process the store is synchronous and cannot interleave. Two
 * sessions each read N entries and each write N+1, and the loser's note is gone
 * while its tool told the model it was saved.
 *
 * The children run this module's real source. Node strips the types, and a
 * resolve hook supplies the `.ts` behind each `./x.js` specifier, the same
 * files the app ships, not a copy that could drift away from them.
 *
 * Each child holds its read open for READ_DELAY_MS before writing. Real
 * sessions are seconds apart, not microseconds, and a window that narrow would
 * let the unserialized version pass by luck rather than by correctness.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A crashed holder's identity: this machine, and a process that has exited.
 *
 * The pid comes from a real short-lived child rather than being made up,
 * because "not running" is exactly what the lock asks about and a guessed
 * number could belong to something alive. A spawn that produced no pid fails
 * the test rather than falling back to a number: pid 1 is init, which is
 * always running, and would quietly turn this into its own opposite.
 */
const deadHolder = (): string => {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);

  if (pid == null)
    throw new Error("could not spawn a process to take a pid from");

  return JSON.stringify({ host: os.hostname(), pid, nonce: "crashed" });
};

/** This process, which is unambiguously still running. */
const liveHolder = (note: string): string =>
  JSON.stringify({ host: os.hostname(), pid: process.pid, nonce: note });
const READ_DELAY_MS = 150;

const RESOLVE_HOOK = `
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      const url = new URL(specifier, context.parentURL);
      if (!fs.existsSync(fileURLToPath(url)))
        return next(specifier.slice(0, -3) + ".ts", context);
    }
    return next(specifier, context);
  },
});
`;

/**
 * Write the resolve hook once, and hand back its path.
 *
 * Once, because the six writers below start together: when each of them wrote
 * this file itself, a child could import it while another was part-way through
 * rewriting it, load a truncated module that never reached `registerHooks`,
 * and then fail to resolve `./config.js`, surfacing as `writer exited 1` from
 * a test that is supposed to be about lock contention.
 */
const writeResolveHook = (): string => {
  const hook = path.join(home, "hook.mjs");

  if (!fs.existsSync(hook)) {
    // Staged and renamed, so the file a child imports is either absent or
    // whole, never the half of it that was on disk at that instant.
    const staged = `${hook}.tmp`;

    fs.writeFileSync(staged, RESOLVE_HOOK, "utf8");
    fs.renameSync(staged, hook);
  }

  return hook;
};

const runWriter = (content: string): Promise<void> => {
  const hook = writeResolveHook();

  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--import",
      pathToFileURL(hook).href,
      "--input-type=module",
      "--eval",
      `
       const fs = (await import("node:fs")).default;
       const read = fs.readFileSync;
       fs.readFileSync = (...args) => {
         const out = read(...args);
         if (String(args[0]).endsWith("MEMORY.md"))
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${READ_DELAY_MS});
         return out;
       };
       const { applyMemoryAction } = await import(${JSON.stringify(
         pathToFileURL(path.join(HERE, "memory-store.ts")).href
       )});
       const result = await applyMemoryAction("memory", "add", { content: ${JSON.stringify(content)} });
       if (!result.ok) { console.error(result.message); process.exit(2); }
      `,
    ],
    { env: { ...process.env, ABACUSAI_BOT_HOME: home }, stdio: "inherit" }
  );

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`writer exited ${String(code)}`))
    );
  });
};

describe("several processes writing the same store", () => {
  const WRITERS = 6;

  it("keeps every entry when they all write at once", async () => {
    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) => runWriter(`Note ${i}.`))
    );

    const entries = readEntries("memory");

    expect(new Set(entries).size).toBe(WRITERS);
    expect(entries).toHaveLength(WRITERS);
  }, 120_000);

  it("does not wedge on a lock whose holder died", async () => {
    // A crashed writer leaves its lock file on disk. Nothing will ever come
    // back to release it, so a lock nobody holds has to be broken rather than
    // waited on; otherwise one crash makes the store permanently unwritable.
    // It is broken at once, whatever its age, because the holder is gone.
    const lock = path.join(home, "memories", "MEMORY.md.lock");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, deadHolder(), "utf8");

    expect(
      (await applyMemoryAction("memory", "add", { content: "After a crash." }))
        .ok
    ).toBe(true);
    expect(readEntries("memory")).toEqual(["After a crash."]);
  }, 30_000);
});

/**
 * What the lock is for, asserted directly.
 *
 * The failure it prevents is silent: the rename is atomic, so a lost entry
 * leaves nothing malformed to notice, and both writers told their model the
 * note was saved. So the assertions are about what a caller is told as much as
 * about what ends up on disk.
 */
describe("two writers reaching one store at the same time", () => {
  it("serializes them rather than letting both read and write", async () => {
    await Promise.all([
      applyMemoryAction("memory", "add", { content: "From one session." }),
      applyMemoryAction("memory", "add", { content: "From another." }),
    ]);

    expect(readEntries("memory")).toEqual([
      "From one session.",
      "From another.",
    ]);
  });

  it("waits on a holder that has stalled, rather than breaking its lock", async () => {
    // The case an age-based rule gets wrong. A holder can be descheduled for
    // seconds (a loaded machine, a home directory on a network filesystem, a
    // virus scanner) and its critical section is synchronous, so it cannot
    // announce that it is still there. Breaking its lock lets a second writer
    // read and write while the first is mid read-modify-write, and one of the
    // two entries is then lost with both callers told they succeeded.
    //
    // The lock file is left untouched for the whole wait: nothing refreshes it,
    // because nothing in the store refreshes it either.
    const lock = path.join(home, "memories", "MEMORY.md.lock");
    const holder = liveHolder("stalled");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, holder, "utf8");

    const result = await applyMemoryAction("memory", "add", {
      content: "Never stored.",
    });

    // Reported, not raced: nothing was written and the caller is told so.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nothing was changed");
    expect(readEntries("memory")).toEqual([]);
    // And the holder's lock is still the holder's.
    expect(fs.readFileSync(lock, "utf8")).toBe(holder);
  }, 30_000);

  it("honours a lock that has been created but not yet stamped", async () => {
    // Taking the lock is two syscalls: create the file, then write who holds
    // it. A waiter that lands in between sees no identity at all. Reading that
    // as "abandoned" deletes the lock of a writer that took it microseconds
    // ago, and then both of them run their read-modify-write.
    const lock = path.join(home, "memories", "MEMORY.md.lock");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "", "utf8");

    const result = await applyMemoryAction("memory", "add", {
      content: "Never stored.",
    });

    expect(result.ok).toBe(false);
    expect(readEntries("memory")).toEqual([]);
    // Left where it was, for the writer that is still stamping it.
    expect(fs.existsSync(lock)).toBe(true);
  }, 30_000);

  it("honours a lock whose identity reached disk only in part", async () => {
    // A write that landed as far as the pid and no further. Read as a complete
    // identity it names a pid that is not running (this one demonstrably is
    // not) and the real holder's lock would be broken underneath it. The
    // trailing nonce is what proves the write finished.
    const lock = path.join(home, "memories", "MEMORY.md.lock");
    const torn = deadHolder().split(":").slice(0, 2).join(":");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, torn, "utf8");

    const result = await applyMemoryAction("memory", "add", {
      content: "Never stored.",
    });

    expect(result.ok).toBe(false);
    expect(readEntries("memory")).toEqual([]);
    expect(fs.readFileSync(lock, "utf8")).toBe(torn);
  }, 30_000);

  it("honours a lock held by another machine, whose processes it cannot ask about", async () => {
    // A home directory shared between two machines. The pid in this lock is not
    // running HERE, and asking about it locally is meaningless: it names a
    // process on the other host, which may well be mid-write. Only the backstop
    // may clear it.
    const lock = path.join(home, "memories", "MEMORY.md.lock");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const elsewhere = deadHolder().replace(os.hostname(), "another-machine");

    fs.writeFileSync(lock, elsewhere, "utf8");

    const result = await applyMemoryAction("memory", "add", {
      content: "Never stored.",
    });

    expect(result.ok).toBe(false);
    expect(readEntries("memory")).toEqual([]);
    expect(fs.readFileSync(lock, "utf8")).toBe(elsewhere);
  }, 30_000);

  it("clears a lock that has outlived every plausible write", async () => {
    // The backstop, and the only thing that can break this lock: the holder is
    // this very process, so liveness says "still working" forever. Without the
    // bound, a lock left by a crash whose pid has since been reused, or one
    // from a machine that never came back, would shut the store permanently.
    const lock = path.join(home, "memories", "MEMORY.md.lock");

    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, liveHolder("ancient"), "utf8");

    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1_000);

    fs.utimesSync(lock, longAgo, longAgo);

    const result = await applyMemoryAction("memory", "add", {
      content: "After the backstop.",
    });

    expect(result.ok).toBe(true);
    expect(readEntries("memory")).toEqual(["After the backstop."]);
  }, 30_000);

  it("leaves no nameless lock behind when stamping it fails", async () => {
    // The file is created and then stamped, two calls. If the second fails
    // (a full disk is the usual reason), the lock on disk names nobody, and a
    // nameless lock is honoured rather than broken, so leaving it would hold
    // the store shut until the backstop.
    const lock = path.join(home, "memories", "MEMORY.md.lock");
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    try {
      const result = await applyMemoryAction("memory", "add", {
        content: "Never stored.",
      });

      expect(result.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(lock)).toBe(false);
    // And the store is usable again straight away.
    expect(
      (await applyMemoryAction("memory", "add", { content: "Next writer." })).ok
    ).toBe(true);
  }, 30_000);

  it("never releases a lock that belongs to somebody else", async () => {
    const lock = path.join(home, "memories", "MEMORY.md.lock");
    const other = deadHolder();
    // Stand in for a lock that changed hands mid-write: the write below is
    // under way when the file does.
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((
      from: string,
      to: string
    ) => {
      fs.writeFileSync(lock, other, "utf8");
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    }) as typeof fs.renameSync);

    try {
      await applyMemoryAction("memory", "add", { content: "Mine." });
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(lock, "utf8")).toBe(other);
  });
});

describe("what the user asked to be remembered", () => {
  it("says nothing when nothing has been asked", () => {
    expect(rememberSnapshot()).toBeNull();
  });

  it("reads back what was stored, under its own header", async () => {
    await applyMemoryAction("remember", "add", { content: "I like blue" });

    const snapshot = rememberSnapshot();

    expect(snapshot).toContain("ALWAYS REMEMBER");
    expect(snapshot).toContain("- I like blue");
  });

  it("stays out of the frozen snapshot", async () => {
    // The other two are read once at spawn so the prompt prefix holds still.
    // This store is re-read every turn instead, and must not be counted twice,
    // nor turn an otherwise-empty install into a snapshot that carries a
    // header for stores with nothing in them.
    await applyMemoryAction("remember", "add", { content: "I like blue" });

    expect(memorySnapshot()).toBeNull();
  });

  it("is its own file, beside the agent's own notes", async () => {
    await applyMemoryAction("remember", "add", { content: "I like blue" });
    await applyMemoryAction("memory", "add", { content: "Node 22 is needed" });

    expect(readEntries("remember")).toEqual(["I like blue"]);
    expect(readEntries("memory")).toEqual(["Node 22 is needed"]);
  });
});
