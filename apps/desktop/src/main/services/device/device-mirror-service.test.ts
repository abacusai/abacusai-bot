/**
 * The stream* payloads ride fire-and-forget IPC (ipcMain.on): there is no
 * reply channel for a malformed one to fail on, so the validators are what
 * stands between renderer-supplied garbage and an uncaught throw in main.
 */
import os from "os";

import { describe, expect, it, vi } from "vitest";

// device-mirror-service reaches electron through its transport imports; the
// tests only exercise the payload validators, so a stub app is enough.
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

import {
  DeviceMirrorService,
  isValidStreamKeyRequest,
  isValidStreamTouchRequest,
} from "./device-mirror-service";
import { DeviceService } from "./device-service";

const touch = {
  platform: "ios",
  deviceId: "sim-1",
  phase: "tap",
  x: 0.5,
  y: 0.5,
};

const key = {
  platform: "android",
  deviceId: "emulator-5554",
  code: "KeyA",
  key: "a",
};

describe("isValidStreamTouchRequest", () => {
  it("accepts a well-formed payload", () => {
    expect(isValidStreamTouchRequest(touch)).toBe(true);
    expect(
      isValidStreamTouchRequest({
        ...touch,
        platform: "android",
        phase: "move",
        deviceWidth: 1080,
        deviceHeight: 1920,
      })
    ).toBe(true);
  });

  it("rejects payloads that are not objects", () => {
    expect(isValidStreamTouchRequest(undefined)).toBe(false);
    expect(isValidStreamTouchRequest(null)).toBe(false);
    expect(isValidStreamTouchRequest("tap")).toBe(false);
    expect(isValidStreamTouchRequest(42)).toBe(false);
  });

  it("rejects wrong or missing fields", () => {
    expect(isValidStreamTouchRequest({ ...touch, platform: "web" })).toBe(
      false
    );
    expect(isValidStreamTouchRequest({ ...touch, deviceId: 7 })).toBe(false);
    expect(isValidStreamTouchRequest({ ...touch, phase: "hold" })).toBe(false);
    expect(isValidStreamTouchRequest({ ...touch, x: "0.5" })).toBe(false);
    expect(isValidStreamTouchRequest({ ...touch, y: NaN })).toBe(false);
    expect(isValidStreamTouchRequest({ ...touch, x: undefined })).toBe(false);
  });

  it("rejects non-numeric device dimensions but allows absent ones", () => {
    expect(isValidStreamTouchRequest({ ...touch, deviceWidth: "1080" })).toBe(
      false
    );
    expect(
      isValidStreamTouchRequest({ ...touch, deviceHeight: Infinity })
    ).toBe(false);
  });
});

describe("isValidStreamKeyRequest", () => {
  it("accepts a well-formed payload", () => {
    expect(isValidStreamKeyRequest(key)).toBe(true);
    expect(
      isValidStreamKeyRequest({ ...key, platform: "ios", shift: true })
    ).toBe(true);
  });

  it("rejects payloads that are not objects", () => {
    expect(isValidStreamKeyRequest(undefined)).toBe(false);
    expect(isValidStreamKeyRequest(null)).toBe(false);
    expect(isValidStreamKeyRequest("Enter")).toBe(false);
  });

  it("rejects wrong or missing fields", () => {
    expect(isValidStreamKeyRequest({ ...key, platform: "web" })).toBe(false);
    expect(isValidStreamKeyRequest({ ...key, deviceId: null })).toBe(false);
    expect(isValidStreamKeyRequest({ ...key, code: 65 })).toBe(false);
    expect(isValidStreamKeyRequest({ ...key, key: undefined })).toBe(false);
  });
});

describe("a keyboard press from the mirror", () => {
  /**
   * The payload is a valid one — every field is a string — so the validators
   * pass it through, and the key tables are what stands between a property
   * name every object has and a value the input path treats as a keycode.
   */
  const service = new DeviceMirrorService(new DeviceService(), {
    emitEvent: () => {},
    resolveWorkspacePath: () => null,
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "drops the key code %j instead of throwing in main",
    (code) => {
      for (const platform of ["android", "ios"] as const) {
        expect(() =>
          service.streamDeviceKey({
            platform,
            deviceId: "emulator-5554",
            code,
            key: code,
          })
        ).not.toThrow();
      }
    }
  );

  it("still handles a key code the tables really carry", () => {
    expect(() =>
      service.streamDeviceKey({
        platform: "android",
        deviceId: "emulator-5554",
        code: "Escape",
        key: "Escape",
      })
    ).not.toThrow();
  });
});
