import { describe, expect, it, vi } from "vitest";

import { readClipboardImage } from "./clipboard-image";

const dependencies = () => ({
  read: vi
    .fn<Parameters<typeof readClipboardImage>[0]["read"]>()
    .mockResolvedValue([]),
  toPNG: vi.fn(() => Buffer.from("converted PNG")),
  logError: vi.fn(),
});

describe("read-clipboard-image attachment contract", () => {
  it("reads the first image item, preferring PNG", async () => {
    const deps = dependencies();
    const getType = vi.fn().mockResolvedValue(new Blob(["PNG bytes"]));
    deps.read.mockResolvedValue([
      { types: ["text/plain"], getType: vi.fn() },
      { types: ["image/jpeg", "image/png"], getType },
    ]);
    expect(await readClipboardImage(deps)).toEqual({
      name: expect.stringMatching(/^clipboard-\d+\.png$/),
      data: Buffer.from("PNG bytes"),
      mimeType: "image/png",
    });
    expect(getType).toHaveBeenCalledWith("image/png");
    expect(deps.toPNG).not.toHaveBeenCalled();
  });

  it("returns null for an empty clipboard", async () => {
    expect(await readClipboardImage(dependencies())).toBeNull();
  });

  it("returns null for a non-image clipboard without reading payloads", async () => {
    const deps = dependencies();
    const getType = vi.fn();
    deps.read.mockResolvedValue([
      { types: ["text/plain", "text/html"], getType },
    ]);
    expect(await readClipboardImage(deps)).toBeNull();
    expect(getType).not.toHaveBeenCalled();
  });

  it("converts a non-PNG image to PNG", async () => {
    const deps = dependencies();
    deps.read.mockResolvedValue([
      {
        types: ["image/jpeg"],
        getType: vi.fn().mockResolvedValue(new Blob(["JPEG bytes"])),
      },
    ]);
    expect(await readClipboardImage(deps)).toEqual(
      expect.objectContaining({
        data: Buffer.from("converted PNG"),
        mimeType: "image/png",
      })
    );
    expect(deps.toPNG).toHaveBeenCalledWith(Buffer.from("JPEG bytes"));
  });

  it("returns null for empty image data", async () => {
    const deps = dependencies();
    deps.read.mockResolvedValue([
      { types: ["image/png"], getType: vi.fn().mockResolvedValue(new Blob()) },
    ]);
    expect(await readClipboardImage(deps)).toBeNull();
  });

  it.each(["read", "getType", "toPNG"])(
    "logs unexpected %s errors",
    async (operation) => {
      const deps = dependencies();
      const error = new Error("clipboard unavailable");
      const getType = vi.fn().mockResolvedValue(new Blob(["JPEG bytes"]));
      deps.read.mockResolvedValue([{ types: ["image/jpeg"], getType }]);
      if (operation === "read") deps.read.mockRejectedValue(error);
      else if (operation === "getType") getType.mockRejectedValue(error);
      else
        deps.toPNG.mockImplementation(() => {
          throw error;
        });
      expect(await readClipboardImage(deps)).toBeNull();
      expect(deps.logError).toHaveBeenCalledWith(error);
    }
  );
});
