/**
 * Where Chromium-family browsers keep their profiles on Linux.
 *
 * Chromium honors $XDG_CONFIG_HOME; hardcoding ~/.config missed every profile
 * on a machine that sets it.
 */
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, session: {} }));

import { linuxConfigRoot } from "./browser-profiles-service";

describe("the Linux config root", () => {
  it("honors XDG_CONFIG_HOME when it is set to an absolute path", () => {
    expect(
      linuxConfigRoot({ XDG_CONFIG_HOME: "/data/config" }, "/home/u")
    ).toBe("/data/config");
  });

  it("falls back to ~/.config when the variable is unset", () => {
    expect(linuxConfigRoot({}, "/home/u")).toBe(
      path.join("/home/u", ".config")
    );
  });

  it("ignores a relative XDG_CONFIG_HOME, as the basedir spec requires", () => {
    expect(linuxConfigRoot({ XDG_CONFIG_HOME: "cfg" }, "/home/u")).toBe(
      path.join("/home/u", ".config")
    );
  });
});
