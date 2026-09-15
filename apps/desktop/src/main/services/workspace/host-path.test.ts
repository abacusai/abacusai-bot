import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openHostFile, resolveHostPath } from "./host-path";

const root = path.join("/Users/dev", "project");
const home = "/Users/dev";

describe("resolving a path the agent named", () => {
  it("maps the guest workspace prefix onto the host workspace", () => {
    expect(resolveHostPath("/workspace/src/a.ts", root, home)).toBe(
      path.join(root, "src", "a.ts")
    );
    expect(resolveHostPath("/workspace", root, home)).toBe(root);
  });

  it("expands ~ to the home directory rather than joining it onto the workspace", () => {
    // The bug: `~/Desktop/x.png` became `<workspace>/~/Desktop/x.png`, and
    // the preview reported the file missing while it sat on the Desktop.
    expect(resolveHostPath("~/Desktop/x.png", root, home)).toBe(
      path.join(home, "Desktop", "x.png")
    );
    expect(resolveHostPath("~", root, home)).toBe(home);
  });

  it("leaves an absolute path alone and joins a relative one onto the workspace", () => {
    expect(resolveHostPath("/etc/hosts", root, home)).toBe("/etc/hosts");
    expect(resolveHostPath("src/a.ts", root, home)).toBe(
      path.join(root, "src", "a.ts")
    );
  });

  it("does not treat a name that merely starts with a tilde as home", () => {
    expect(resolveHostPath("~backup/a.txt", root, home)).toBe(
      path.join(root, "~backup", "a.txt")
    );
  });
});

describe("opening the file behind a path the agent named", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "host-path-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds a name the model wrote with a plain space where the disk has a narrow one", async () => {
    // macOS names screenshots with U+202F before "AM"; every transcript of
    // that name comes back with an ordinary space, and the exact path misses.
    const onDisk = path.join(root, "Screenshot 2026-09-14 at 12.55.59 AM.png");
    fs.writeFileSync(onDisk, "png");

    const file = await openHostFile(
      "Screenshot 2026-09-14 at 12.55.59 AM.png",
      root
    );

    expect(file.ok).toBe(true);
    // The async realpath, as the code uses: on Windows the sync one can keep
    // the temp dir's 8.3 short name and the two disagree.
    if (file.ok) expect(file.realFile).toBe(await fs.promises.realpath(onDisk));
  });

  it("matches a decomposed name against its composed form", async () => {
    const onDisk = path.join(root, "café.md");
    fs.writeFileSync(onDisk, "#");

    const file = await openHostFile("café.md", root);

    expect(file.ok).toBe(true);
  });

  it("does not guess between two names that read the same", async () => {
    fs.writeFileSync(path.join(root, "a b.txt"), "1");
    fs.writeFileSync(path.join(root, "a b.txt"), "2");

    const file = await openHostFile("a b.txt", root);

    expect(file).toEqual({ ok: false, error: "not-found" });
  });

  it("reports a genuinely missing file as not found", async () => {
    expect(await openHostFile("ghost.png", root)).toEqual({
      ok: false,
      error: "not-found",
    });
  });

  it("refuses a file that resolves outside the root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "host-path-out-"));
    fs.writeFileSync(path.join(outside, "x.txt"), "x");

    const file = await openHostFile(path.join(outside, "x.txt"), root);

    expect(file).toEqual({ ok: false, error: "outside-root" });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("reports a directory as not a file", async () => {
    fs.mkdirSync(path.join(root, "dir"));

    expect(await openHostFile("dir", root)).toEqual({
      ok: false,
      error: "not-a-file",
    });
  });
});
