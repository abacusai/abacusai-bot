import path from "path";

import { describe, expect, it } from "vitest";

import { resolveHostPath } from "./host-path";

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
