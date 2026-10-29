/** Stage-and-rename writes, including the Windows EPERM retry. */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backupPathFor,
  recoverFromBackupSync,
  writeFileAtomic,
  writeFileAtomicSync,
} from "./atomic-file.js";

let dir: string;
const target = (): string => path.join(dir, "nested", "store.json");

const tempFiles = (): string[] => {
  const parent = path.dirname(target());
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent)
    .filter((name) => name.endsWith(".tmp"))
    .sort();
};

const epermError = (): Error =>
  Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writing a file into place", () => {
  it("creates the directory it was given and leaves no temp file", () => {
    writeFileAtomicSync(target(), "hello");

    expect(fs.readFileSync(target(), "utf-8")).toBe("hello");
    expect(tempFiles()).toEqual([]);
  });

  it("stages under a name of its own, so two writers never share one", () => {
    const staged: string[] = [];
    const real = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      staged.push(String(from));
      real(from, to);
    });

    writeFileAtomicSync(target(), "first");
    writeFileAtomicSync(target(), "second");

    expect(staged[0]).not.toBe(staged[1]);
    expect(fs.readFileSync(target(), "utf-8")).toBe("second");
  });
});

describe("durability", () => {
  // A rename the disk commits ahead of the data leaves a file of NUL bytes
  // after a power loss: the bytes must be flushed first.
  it("flushes the staged bytes before the rename", () => {
    const calls: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      calls.push("fsync");
      fsync(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      calls.push("rename");
      rename(from, to);
    });

    writeFileAtomicSync(target(), "durable");

    expect(calls.indexOf("fsync")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("fsync")).toBeLessThan(calls.indexOf("rename"));
    expect(fs.readFileSync(target(), "utf-8")).toBe("durable");
  });

  it("flushes before the rename in the async half too", async () => {
    const calls: string[] = [];
    const open = fsPromises.open;
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        calls.push("sync");
        await sync();
      };
      return handle;
    });
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      calls.push("rename");
      await rename(from, to);
    });

    await writeFileAtomic(target(), "durable");

    expect(calls.indexOf("sync")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("sync")).toBeLessThan(calls.indexOf("rename"));
  });
});

describe("keepBackup and recoverFromBackupSync", () => {
  const isList = (text: string): boolean => {
    try {
      return Array.isArray(JSON.parse(text));
    } catch {
      return false;
    }
  };
  const nulFilled = (): string => "\0".repeat(64);
  const asideFiles = (): string[] =>
    fs
      .readdirSync(path.dirname(target()))
      .filter((name) => name.includes(".corrupt-"));

  it("keeps the same bytes in the backup", () => {
    writeFileAtomicSync(target(), "[1]", { keepBackup: true });

    expect(fs.readFileSync(backupPathFor(target()), "utf-8")).toBe("[1]");
  });

  it("puts the last good copy back over a NUL-filled file, keeping the bad bytes beside it", () => {
    writeFileAtomicSync(target(), "[1,2]", { keepBackup: true });
    fs.writeFileSync(target(), nulFilled());

    expect(recoverFromBackupSync(target(), isList)).toBe("[1,2]");
    expect(fs.readFileSync(target(), "utf-8")).toBe("[1,2]");
    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(path.dirname(target()), aside[0]!), "utf-8")
    ).toBe(nulFilled());
  });

  it.each([
    ["no backup", null],
    ["a backup that is no better", "\0\0\0"],
  ])("leaves the file exactly as it is with %s", (_label, backup) => {
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), nulFilled());
    if (backup !== null) fs.writeFileSync(backupPathFor(target()), backup);

    expect(recoverFromBackupSync(target(), isList)).toBeNull();
    expect(fs.readFileSync(target(), "utf-8")).toBe(nulFilled());
    expect(asideFiles()).toEqual([]);
  });
});

describe("a rename the platform bounces", () => {
  it("waits out a reader's open handle", () => {
    const real = fs.renameSync;
    let attempts = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      attempts++;
      if (attempts === 1) throw epermError();
      real(from, to);
    });

    writeFileAtomicSync(target(), "survived");

    expect(attempts).toBe(2);
    expect(fs.readFileSync(target(), "utf-8")).toBe("survived");
    expect(tempFiles()).toEqual([]);
  });

  it("gives up rather than stalling, and cleans up after itself", () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw epermError();
    });

    expect(() => writeFileAtomicSync(target(), "doomed")).toThrow(/EPERM/);
    expect(tempFiles()).toEqual([]);
  });

  it("does not wait out an error that waiting cannot clear", () => {
    let attempts = 0;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      attempts++;
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    });

    expect(() => writeFileAtomicSync(target(), "doomed")).toThrow(/ENOSPC/);
    expect(attempts).toBe(1);
  });
});

describe("skipIfUnchanged", () => {
  it("does not touch the file when the bytes already match", () => {
    writeFileAtomicSync(target(), "same", { skipIfUnchanged: true });
    const renameSync = vi.spyOn(fs, "renameSync");

    writeFileAtomicSync(target(), "same", { skipIfUnchanged: true });

    expect(renameSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(target(), "utf-8")).toBe("same");
  });

  it("writes when the content differs", () => {
    writeFileAtomicSync(target(), "before", { skipIfUnchanged: true });

    writeFileAtomicSync(target(), "after", { skipIfUnchanged: true });

    expect(fs.readFileSync(target(), "utf-8")).toBe("after");
  });
});

describe("the async half", () => {
  it("writes into place and cleans up", async () => {
    await writeFileAtomic(target(), "async hello");

    expect(fs.readFileSync(target(), "utf-8")).toBe("async hello");
    expect(tempFiles()).toEqual([]);
  });

  it("cleans up after a rename that never succeeds", async () => {
    vi.spyOn(fsPromises, "rename").mockRejectedValue(epermError());

    await expect(writeFileAtomic(target(), "doomed")).rejects.toThrow(/EPERM/);
    expect(tempFiles()).toEqual([]);
  });
});

describe("restrict", () => {
  // Windows has no POSIX modes, so there is nothing to assert there.
  it.skipIf(process.platform === "win32")(
    "keeps the file readable by its owner alone",
    () => {
      writeFileAtomicSync(target(), "secret", { restrict: true });

      expect(fs.statSync(target()).mode & 0o777).toBe(0o600);
    }
  );
});
