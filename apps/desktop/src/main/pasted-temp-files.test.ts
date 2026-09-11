/**
 * Pasted-attachment names come from the renderer. The resolver must keep every
 * write a direct child of the temp dir, whatever the name tries.
 */
import path from "path";

import { describe, expect, it } from "vitest";

import { resolvePastedFilePath } from "./pasted-temp-files";

const tempDir = path.join(path.sep, "ws", ".abacusai-bot", "temp");

describe("resolvePastedFilePath", () => {
  it("resolves an honest name to a child of the temp dir", () => {
    expect(resolvePastedFilePath(tempDir, "shot.png")).toBe(
      path.join(tempDir, "shot.png")
    );
  });

  it("keeps only the final segment of a path-shaped name", () => {
    expect(resolvePastedFilePath(tempDir, "a/b/shot.png")).toBe(
      path.join(tempDir, "shot.png")
    );
  });

  it("defuses traversal names instead of writing outside the dir", () => {
    expect(resolvePastedFilePath(tempDir, "../../../etc/cron.d/x")).toBe(
      path.join(tempDir, "x")
    );
    expect(() => resolvePastedFilePath(tempDir, "../../..")).toThrow(
      /Invalid pasted file name/
    );
  });

  it("rejects names with no usable final segment", () => {
    for (const name of ["", ".", "..", "/", "a/.."]) {
      expect(() => resolvePastedFilePath(tempDir, name)).toThrow(
        /Invalid pasted file name/
      );
    }
  });

  it("rejects non-string names", () => {
    expect(() =>
      resolvePastedFilePath(tempDir, undefined as unknown as string)
    ).toThrow(/Invalid pasted file name/);
  });
});

/**
 * Windows reads more into a name than POSIX does, and every one of these
 * spellings survives `basename`. Driven with an explicit platform so the cases
 * run everywhere, not only on a Windows machine.
 */
describe("resolvePastedFilePath on Windows", () => {
  const winTemp = "C:\\ws\\.abacusai-bot\\temp";
  const reject = (name: string): void => {
    expect(() => resolvePastedFilePath(winTemp, name, "win32")).toThrow(
      /Invalid pasted file name/
    );
  };

  it("resolves an honest name to a child of the temp dir", () => {
    expect(resolvePastedFilePath(winTemp, "shot.png", "win32")).toBe(
      `${winTemp}\\shot.png`
    );
  });

  it("rejects a colon, which names a stream on another file", () => {
    reject("a.txt:b.exe");
    reject("a.txt:b");
  });

  it("rejects trailing dots and spaces, which the filesystem strips", () => {
    // "x.txt." and "x.txt " both resolve to x.txt, so a second paste would
    // quietly replace the first attachment.
    reject("x.txt.");
    reject("x.txt ");
  });

  it("rejects reserved device names, with or without an extension", () => {
    for (const name of ["CON", "nul", "AUX", "com1", "LPT9", "con.txt"]) {
      reject(name);
    }
  });

  it("leaves those spellings alone on POSIX, where they are just names", () => {
    expect(resolvePastedFilePath("/tmp", "a.txt:b.exe", "linux")).toBe(
      "/tmp/a.txt:b.exe"
    );
    expect(resolvePastedFilePath("/tmp", "CON", "linux")).toBe("/tmp/CON");
    expect(resolvePastedFilePath("/tmp", "x.txt.", "linux")).toBe(
      "/tmp/x.txt."
    );
  });
});
