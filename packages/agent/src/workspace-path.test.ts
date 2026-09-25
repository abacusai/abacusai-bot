/**
 * The schemas promise "relative paths resolve against the workspace". They did
 * not: the path went to the desktop as typed, and the host resolved it against
 * the MAIN PROCESS's cwd (`/` in a packaged app). A deck asked for at
 * `dating-apps-comparison/deck.pdf` tried to `mkdir /dating-apps-comparison`
 * and died with ENOENT at the root of the disk.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isInsideDirectory,
  realPathOf,
  resolveInWorkspace,
} from "./workspace-path.js";

// Resolved, so the assertions below can be built from it on either platform:
// on Windows a rooted path like this one picks up the current drive letter.
const workspace = path.resolve("/Users/someone/work/project");

describe("resolving where the model wants a file written", () => {
  it("puts a bare relative path inside the workspace, not at the root", () => {
    expect(
      resolveInWorkspace("dating-apps-comparison/deck.pdf", workspace)
    ).toBe(path.join(workspace, "dating-apps-comparison/deck.pdf"));
  });

  it("keeps a plain filename in the workspace", () => {
    expect(resolveInWorkspace("deck.pdf", workspace)).toBe(
      path.join(workspace, "deck.pdf")
    );
  });

  it("leaves an absolute path exactly where the model asked for it", () => {
    const elsewhere = path.resolve(path.sep, "tmp", "deck.pdf");

    expect(resolveInWorkspace(elsewhere, workspace)).toBe(elsewhere);
  });

  it("expands ~ against the home directory, not the workspace", () => {
    expect(resolveInWorkspace("~/Desktop/deck.pdf", workspace)).toBe(
      path.join(os.homedir(), "Desktop/deck.pdf")
    );
  });

  it("tolerates the whitespace a model leaves on a path", () => {
    expect(resolveInWorkspace("  reports/q3.pdf  ", workspace)).toBe(
      path.join(workspace, "reports/q3.pdf")
    );
  });

  it("resolves ./ and ../ against the workspace as well", () => {
    expect(resolveInWorkspace("./out/deck.pdf", workspace)).toBe(
      path.join(workspace, "out/deck.pdf")
    );
    expect(resolveInWorkspace("../sibling/deck.pdf", workspace)).toBe(
      path.join(path.dirname(workspace), "sibling", "deck.pdf")
    );
  });
});

/**
 * The gates ask realPathOf where a write would really land, and a symlink
 * whose target does not exist yet is the tricky case: realpath throws on it
 * exactly as on a plain missing file, but writing THROUGH the link creates its
 * target, so the answer has to be the target, not the link's own name.
 */
describe("the real path of what does not exist yet", () => {
  let dir: string;
  // Somewhere that does not exist, spelled the way the running platform does.
  const outside = path.resolve(path.sep, "outside", "somewhere");

  beforeEach(() => {
    // Realpathed up front: on macOS the temp dir itself is behind a symlink
    // (/var/folders vs /private/var/folders), and these assertions are about
    // the leaf, not that mapping. The native realpath, because on Windows
    // os.tmpdir() is the 8.3 short name and that is what realPathOf expands.
    dir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "realpath-"))
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a plain missing file where it lexically is", () => {
    expect(realPathOf(path.join(dir, "new-file.txt"))).toBe(
      path.join(dir, "new-file.txt")
    );
  });

  it("resolves a dangling link to its target, not its own name", () => {
    const link = path.join(dir, "notes.txt");
    const target = path.join(outside, "target.txt");
    fs.symlinkSync(target, link);

    expect(realPathOf(link)).toBe(target);
  });

  it("resolves a RELATIVE dangling link against the link's directory", () => {
    const link = path.join(dir, "notes.txt");
    fs.symlinkSync(path.join("..", "escaped.txt"), link);

    expect(realPathOf(link)).toBe(path.join(path.dirname(dir), "escaped.txt"));
  });

  it("follows a chain of dangling links to the end", () => {
    const target = path.join(outside, "target.txt");
    fs.symlinkSync(path.join(dir, "middle.txt"), path.join(dir, "first.txt"));
    fs.symlinkSync(target, path.join(dir, "middle.txt"));

    expect(realPathOf(path.join(dir, "first.txt"))).toBe(target);
  });

  it("keeps judging a missing file under a dangling-link directory by the link", () => {
    fs.symlinkSync(outside, path.join(dir, "outdir"));

    expect(realPathOf(path.join(dir, "outdir", "new.txt"))).toBe(
      path.join(outside, "new.txt")
    );
  });

  it("gives up on a link loop instead of answering with the link's own path", () => {
    const loop = path.join(dir, "loop.txt");
    fs.symlinkSync(loop, loop);

    // Returning the lexical path would hand containment a path it believes is
    // an ordinary file inside the directory. There is no true answer here, so
    // there is no answer.
    expect(realPathOf(loop)).toBeNull();
  });

  it("counts a long chain as a loop rather than answering from a stale hop", () => {
    for (let i = 0; i < 60; i++) {
      fs.symlinkSync(
        path.join(dir, `link-${i + 1}`),
        path.join(dir, `link-${i}`)
      );
    }

    expect(realPathOf(path.join(dir, "link-0"))).toBeNull();
  });

  it("puts an unresolvable path outside every directory", () => {
    const loop = path.join(dir, "loop.txt");
    fs.symlinkSync(loop, loop);

    expect(isInsideDirectory(loop, dir)).toBe(false);
  });

  it("still places an ordinary missing file inside its directory", () => {
    expect(isInsideDirectory(path.join(dir, "new.txt"), dir)).toBe(true);
  });

  it("puts a dangling link that points out of the directory outside it", () => {
    const link = path.join(dir, "notes.txt");
    fs.symlinkSync("/outside/somewhere/target.txt", link);

    expect(isInsideDirectory(link, dir)).toBe(false);
  });
});
