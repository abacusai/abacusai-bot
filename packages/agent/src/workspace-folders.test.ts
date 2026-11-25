/** What may join a chat's folders, and what the model is told about them. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hostWorkspaceFolders,
  setHostWorkspaceFolders,
  workspaceFolderRefusal,
  workspaceFoldersPrompt,
} from "./workspace-folders.js";

let home = "";
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-home-")));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  setHostWorkspaceFolders([]);
});

describe.skipIf(process.platform === "win32")("workspaceFolderRefusal", () => {
  it.each([
    ["Desktop", null],
    ["Documents/project", null],
    ["Google Drive/My Drive/site", null],
    [".ssh", "folder-not-allowed"],
    [".abacusai-bot/session-home", "folder-not-allowed"],
    ["Library/Application Support", "folder-not-allowed"],
  ])("~/%s → %s", (relative, refusal) => {
    expect(workspaceFolderRefusal(path.join(home, relative), home)).toBe(
      refusal
    );
  });

  it("refuses the home folder, what holds it, a root and the system", () => {
    for (const folder of [home, path.dirname(home), "/", "/etc", "/usr/lib"])
      expect(workspaceFolderRefusal(folder, home)).toBe("folder-not-allowed");
  });

  it("allows another volume or a shared folder", () => {
    expect(workspaceFolderRefusal("/Volumes/Work/site", home)).toBeNull();
  });
});

describe("the host's list", () => {
  it("keeps absolute paths once each, and an unreadable list keeps the last", () => {
    setHostWorkspaceFolders(["/a", "relative", "/a", 3, "/b"]);
    expect(hostWorkspaceFolders()).toEqual(["/a", "/b"]);
    setHostWorkspaceFolders("not a list");
    expect(hostWorkspaceFolders()).toEqual(["/a", "/b"]);
  });
});

describe("the prompt block", () => {
  it("names the chat's own folder first, then the added ones, and the saving rule", () => {
    const text = workspaceFoldersPrompt("/s/session-home", [
      "/Users/dev/Drive/site",
    ]);
    expect(text).toContain("- /s/session-home (this chat's own folder)");
    expect(text).toContain("- /Users/dev/Drive/site");
    expect(text).toMatch(/Never hand over a file from the system temp folder/);
    expect(text).toMatch(/scratch files go in this chat's own folder/);
  });

  it("shows a Windows folder with forward slashes", () => {
    expect(workspaceFoldersPrompt("C:\\Users\\dev\\chat", [])).toContain(
      "C:/Users/dev/chat"
    );
  });
});
