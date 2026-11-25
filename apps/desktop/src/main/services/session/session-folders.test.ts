/** What a path names once checked, and which paths a user message attached. */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachedKind,
  attachedPathsOf,
  resolveSessionFolder,
} from "./session-folders";

let home = "";
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folders-")));
  fs.mkdirSync(path.join(home, "Desktop", "site"), { recursive: true });
  fs.writeFileSync(path.join(home, "Desktop", "brief.pdf"), "%PDF-1.4\n");
  fs.mkdirSync(path.join(home, ".config"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("resolveSessionFolder", () => {
  it("a real folder of the user's joins, as its real path", async () => {
    fs.symlinkSync(path.join(home, "Desktop", "site"), path.join(home, "link"));
    await expect(
      resolveSessionFolder(path.join(home, "link"), home)
    ).resolves.toEqual({
      ok: true,
      folder: path.join(home, "Desktop", "site"),
    });
  });

  it.each([
    ["a file", "Desktop/brief.pdf", "not-a-folder"],
    ["nothing", "Desktop/gone", "not-a-folder"],
    ["a relative path", "relative", "not-a-folder"],
    ["the home folder", "", "folder-not-allowed"],
    ["a dotfolder", ".config", "folder-not-allowed"],
  ])("%s is refused", async (_case, relative, error) => {
    const input =
      relative === "relative" ? "Desktop" : path.join(home, relative);
    await expect(resolveSessionFolder(input, home)).resolves.toEqual({
      ok: false,
      error,
    });
  });
});

describe("attachedPathsOf", () => {
  it("reads the composer's @ lines, absolute only, once each", () => {
    const text = [
      "Make a site from these",
      "",
      "@/Users/dev/Drive/site",
      "@C:/Users/dev/Desktop/brief.pdf",
      "@/Users/dev/Drive/site",
      "@notes.md",
      "email me @ noon",
    ].join("\n");
    expect(attachedPathsOf(text)).toEqual([
      "/Users/dev/Drive/site",
      "C:/Users/dev/Desktop/brief.pdf",
    ]);
  });
});

describe("attachedKind", () => {
  it("tells a folder from a file, and nothing from a missing path", async () => {
    await expect(
      attachedKind(path.join(home, "Desktop", "site"))
    ).resolves.toEqual({
      kind: "folder",
      real: path.join(home, "Desktop", "site"),
    });
    await expect(
      attachedKind(path.join(home, "Desktop", "brief.pdf"))
    ).resolves.toMatchObject({ kind: "file" });
    await expect(attachedKind(path.join(home, "gone"))).resolves.toBeNull();
  });
});
