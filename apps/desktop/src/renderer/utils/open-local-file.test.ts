/**
 * The guard turns some clicks away. When it does, the user has to be told:
 * a file link that produces nothing at all is indistinguishable from a bug,
 * which is exactly what the silent version of this looked like.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openLocalFile } from "./open-local-file";

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

const openFilePath = vi.fn();

beforeEach(() => {
  toast.info.mockClear();
  toast.error.mockClear();
  openFilePath.mockReset();
  vi.stubGlobal("window", { api: { openFilePath } });
});

describe("opening a local file from the renderer", () => {
  it("says nothing when the file opens", async () => {
    openFilePath.mockResolvedValue({ outcome: "opened" });

    await openLocalFile("/ws/notes.txt");

    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("explains a file that was shown instead of run", async () => {
    openFilePath.mockResolvedValue({ outcome: "revealed" });

    await openLocalFile("/ws/app.js");

    expect(toast.info).toHaveBeenCalledWith("openFile.revealed");
  });

  it("gives each refusal its own reason", async () => {
    for (const [reason, key] of [
      ["outside", "openFile.refusedOutside"],
      ["missing", "openFile.refusedMissing"],
      ["invalid", "openFile.refusedInvalid"],
    ] as const) {
      openFilePath.mockResolvedValue({ outcome: "refused", reason });

      await openLocalFile("/etc/hosts");

      expect(toast.error).toHaveBeenCalledWith(key);
    }
  });

  it("still reports when the call itself fails", async () => {
    openFilePath.mockRejectedValue(new Error("ipc gone"));

    await openLocalFile("/ws/notes.txt");

    expect(toast.error).toHaveBeenCalledWith("openFile.failed");
  });
});
