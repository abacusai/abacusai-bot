/**
 * The workspace containment on the file operations the tree exposes.
 *
 * It used to be a case-sensitive startsWith on unresolved paths, which is
 * wrong in both directions: on the case-insensitive filesystems of macOS and
 * Windows the same directory spelled with different casing was rejected, and a
 * symlink inside the workspace pointing out of it sailed through. These pin
 * the corrected behavior: real paths, `path.relative`, case folded where the
 * filesystem folds it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileTreeService } from "./file-tree-service";

const onCaseInsensitiveFs =
  process.platform === "darwin" || process.platform === "win32";

let workspace: string;
let outside: string;
let service: FileTreeService;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ft-ws-"));
  outside = mkdtempSync(join(tmpdir(), "ft-out-"));
  service = new FileTreeService();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("writing a file through the tree", () => {
  it("lands inside the workspace", async () => {
    const result = await service.writeFile(workspace, "notes.txt", "hello");

    expect(result).toEqual({ success: true });
  });

  it("refuses a relative path that climbs out", async () => {
    const result = await service.writeFile(workspace, "../escape.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses an absolute path outside the workspace", async () => {
    const result = await service.writeFile(
      workspace,
      join(outside, "escape.txt"),
      "x"
    );

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses a write through a symlink that leaves the workspace", async () => {
    // The link resolves inside the workspace lexically; only following it
    // shows where the bytes would land.
    symlinkSync(outside, join(workspace, "sneaky"));

    const result = await service.writeFile(workspace, "sneaky/escape.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses a write through a DANGLING link that points out of the workspace", async () => {
    // The target does not exist, so realpath fails on the link exactly as it
    // does on a plain missing file, but writing the link creates its target,
    // outside the workspace, rather than a file where the link sits.
    const target = join(outside, "created-by-the-write.txt");
    symlinkSync(target, join(workspace, "notes.txt"));

    const result = await service.writeFile(workspace, "notes.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
    expect(existsSync(target)).toBe(false);
  });

  it("still creates an ordinary new file", async () => {
    // The dangling-link handling must not turn every create into a refusal.
    const result = await service.writeFile(workspace, "brand-new.txt", "x");

    expect(result).toEqual({ success: true });
  });

  it("refuses a write through a link loop instead of trusting its own path", async () => {
    const loop = join(workspace, "loop.txt");
    symlinkSync(loop, loop);

    const result = await service.writeFile(workspace, "loop.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it.runIf(onCaseInsensitiveFs)(
    "accepts the workspace spelled with different casing",
    async () => {
      // Same directory on a case-insensitive filesystem; a case-sensitive
      // string comparison called it a different one and rejected the write.
      const differentlyCased = join(
        dirname(workspace),
        basename(workspace).toUpperCase()
      );

      const result = await service.writeFile(
        differentlyCased,
        "notes.txt",
        "hello"
      );

      expect(result).toEqual({ success: true });
    }
  );

  it.runIf(process.platform === "darwin")(
    "treats a workspace reached through /tmp as itself",
    async () => {
      // /tmp is a symlink to /private/tmp on macOS: the same directory under
      // two spellings, which real paths reconcile.
      const linked = mkdtempSync("/tmp/ft-linked-");
      try {
        const result = await service.writeFile(linked, "notes.txt", "hello");

        expect(result).toEqual({ success: true });
      } finally {
        rmSync(linked, { recursive: true, force: true });
      }
    }
  );
});

describe("renaming a file through the tree", () => {
  it("moves a file within the workspace", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");

    const result = await service.renameFile(workspace, "a.txt", "b.txt");

    expect(result).toEqual({ success: true });
  });

  it("refuses a destination outside the workspace", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");

    const result = await service.renameFile(workspace, "a.txt", "../a.txt");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses a destination inside a symlinked escape hatch", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    symlinkSync(outside, join(workspace, "sneaky"));

    const result = await service.renameFile(workspace, "a.txt", "sneaky/a.txt");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });
});

describe("saving a resolved conflict", () => {
  it("writes inside the workspace", async () => {
    mkdirSync(join(workspace, "src"));

    const result = await service.saveResolvedConflict(
      workspace,
      "src/app.ts",
      "merged"
    );

    expect(result).toEqual({ success: true });
  });

  it("refuses a path outside the workspace", async () => {
    const result = await service.saveResolvedConflict(
      workspace,
      "../app.ts",
      "merged"
    );

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });
});
