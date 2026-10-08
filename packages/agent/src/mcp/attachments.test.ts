/**
 * The desktop/gateway attachment seam: what may be read out of the workspace
 * for an upload, and where server-sent files may land.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AttachmentError,
  rewriteAttachmentParams,
  saveAttachmentBlocks,
} from "./attachments.js";

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "attach-ws-"))
  );
  outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "attach-out-"))
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const blob = (name: string, text: string): Record<string, unknown> => ({
  type: "resource",
  resource: { name, blob: Buffer.from(text).toString("base64") },
});

describe("uploading a workspace file", () => {
  it("sends a file in the workspace as its content", () => {
    fs.writeFileSync(path.join(workspace, "report.txt"), "hello");

    const params = rewriteAttachmentParams(
      { file: "report.txt" },
      ["file"],
      workspace
    );

    expect(params.file).toEqual({
      filename: "report.txt",
      content_base64: Buffer.from("hello").toString("base64"),
    });
  });

  it("refuses a symlink in the workspace that leads out of it", () => {
    fs.writeFileSync(path.join(outside, "secret"), "x");
    fs.symlinkSync(
      path.join(outside, "secret"),
      path.join(workspace, "innocent.txt")
    );

    expect(() =>
      rewriteAttachmentParams({ file: "innocent.txt" }, ["file"], workspace)
    ).toThrow(/outside the workspace/);
  });

  it("never uploads a credential store, even one inside the workspace", () => {
    // The app's own settings hold API keys; here they sit in the workspace.
    const appHome = path.join(workspace, "app-home");
    fs.mkdirSync(appHome);
    fs.writeFileSync(path.join(appHome, "config.json"), '{"key":"sk-test"}');
    vi.stubEnv("ABACUSAI_BOT_HOME", appHome);

    expect(() =>
      rewriteAttachmentParams(
        { file: "app-home/config.json" },
        ["file"],
        workspace
      )
    ).toThrow(AttachmentError);
    expect(() =>
      rewriteAttachmentParams(
        { file: "app-home/config.json" },
        ["file"],
        workspace
      )
    ).toThrow(/credential store/);
  });
});

describe("saving a server-sent file", () => {
  it("writes into the workspace's attachments folder", () => {
    const lines = saveAttachmentBlocks([blob("a.txt", "one")], workspace);

    expect(lines[0]).toContain("Saved attachment a.txt");
    expect(
      fs.readFileSync(path.join(workspace, "attachments", "a.txt"), "utf8")
    ).toBe("one");
  });

  it("refuses an attachments folder that is a symlink", () => {
    fs.symlinkSync(outside, path.join(workspace, "attachments"));

    const lines = saveAttachmentBlocks([blob("a.txt", "one")], workspace);

    expect(lines[0]).toContain("Could not save");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("never writes through a symlink planted under the file's name", () => {
    const target = path.join(outside, "victim");
    fs.writeFileSync(target, "original");
    fs.mkdirSync(path.join(workspace, "attachments"));
    fs.symlinkSync(target, path.join(workspace, "attachments", "a.txt"));

    const lines = saveAttachmentBlocks([blob("a.txt", "evil")], workspace);

    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(lines[0]).toContain("a-1.txt");
    expect(
      fs.readFileSync(path.join(workspace, "attachments", "a-1.txt"), "utf8")
    ).toBe("evil");
  });

  it("keeps a second file of the same name beside the first", () => {
    saveAttachmentBlocks([blob("a.txt", "one")], workspace);
    saveAttachmentBlocks([blob("a.txt", "two")], workspace);

    expect(
      fs.readFileSync(path.join(workspace, "attachments", "a-1.txt"), "utf8")
    ).toBe("two");
  });
});
