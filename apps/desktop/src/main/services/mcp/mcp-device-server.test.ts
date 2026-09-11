/**
 * The decisions the device server makes before anything reaches a device: what
 * the approval prompt tells the user, which platform a call actually drives,
 * and where an install artifact is allowed to come from.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The server reaches Electron through its config import; none of these cases
// touch it.
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

import {
  parseDevicePlatform,
  resolveInstallArtifact,
  summarizeDeviceToolCall,
} from "./mcp-device-server";

describe("summarizing a device call for approval", () => {
  it("shows the text a type action will send", () => {
    const summary = summarizeDeviceToolCall("device_interact", {
      platform: "android",
      action: "type",
      text: "hunter2",
    });
    expect(summary).toContain("hunter2");
  });

  it("shows the key a press_key action will send", () => {
    const summary = summarizeDeviceToolCall("device_interact", {
      platform: "android",
      action: "press_key",
      key: "KEYCODE_APP_SWITCH",
    });
    expect(summary).toContain("KEYCODE_APP_SWITCH");
  });

  it("keeps a long or multi-line value to one readable line", () => {
    const summary = summarizeDeviceToolCall("device_interact", {
      platform: "android",
      action: "type",
      text: `${"a".repeat(400)}\nsecond line`,
    });
    expect(summary).not.toMatch(/\n/);
    expect(summary.length).toBeLessThan(200);
    expect(summary).toContain("…");
  });

  it("still names the target for the other actions", () => {
    expect(
      summarizeDeviceToolCall("device_interact", { action: "tap", ref: "@e3" })
    ).toBe("tap @e3");
  });
});

describe("validating the platform argument", () => {
  it("accepts the two the schema advertises", () => {
    expect(parseDevicePlatform("ios")).toBe("ios");
    expect(parseDevicePlatform("android")).toBe("android");
  });

  it.each(["windows", "Android", "", null, undefined, 7, {}])(
    "rejects %j",
    (value) => {
      expect(parseDevicePlatform(value)).toBeNull();
    }
  );
});

describe("resolving an install artifact", () => {
  let workspace: string;
  let outside: string;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "device-install-"));
    workspace = path.join(base, "workspace");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(workspace, "build"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(workspace, "build", "app.apk"), "apk");
    fs.mkdirSync(path.join(workspace, "build", "App.app"));
    fs.writeFileSync(path.join(outside, "other.apk"), "apk");
    fs.symlinkSync(
      path.join(outside, "other.apk"),
      path.join(workspace, "linked.apk")
    );
  });

  afterAll(() => {
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  it("accepts an artifact inside the workspace", () => {
    const result = resolveInstallArtifact(
      "build/app.apk",
      workspace,
      "android"
    );
    expect(result).toEqual({
      path: fs.realpathSync(path.join(workspace, "build", "app.apk")),
    });
  });

  it("accepts an iOS bundle inside the workspace", () => {
    expect(
      resolveInstallArtifact("build/App.app", workspace, "ios")
    ).toHaveProperty("path");
  });

  it("accepts an artifact this session's build produced", () => {
    // Xcode writes the .app to DerivedData, outside the project entirely.
    const built = fs.realpathSync(path.join(outside, "other.apk"));
    expect(
      resolveInstallArtifact(built, workspace, "android", new Set([built]))
    ).toEqual({ path: built });
  });

  it("refuses a path that leaves the workspace", () => {
    expect(
      resolveInstallArtifact("../outside/other.apk", workspace, "android")
    ).toHaveProperty("error");
    expect(
      resolveInstallArtifact(
        path.join(outside, "other.apk"),
        workspace,
        "android"
      )
    ).toHaveProperty("error");
  });

  it("refuses a workspace symlink that points out of it", () => {
    expect(
      resolveInstallArtifact("linked.apk", workspace, "android")
    ).toHaveProperty("error");
  });

  it("refuses anything that is not the platform's package", () => {
    expect(
      resolveInstallArtifact("build/app.apk", workspace, "ios")
    ).toHaveProperty("error");
    expect(
      resolveInstallArtifact("/bin/sh", workspace, "android")
    ).toHaveProperty("error");
  });

  it("refuses an artifact when there is no workspace", () => {
    expect(resolveInstallArtifact("app.apk", null, "android")).toHaveProperty(
      "error"
    );
  });
});
