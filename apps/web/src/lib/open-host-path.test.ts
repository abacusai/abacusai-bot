/** A chat click on a host file always says what happened unless it opened. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppClient } from "#renderer/data/transport/types";

import { openHostPath } from "./open-host-path";

const toast = vi.hoisted(() => ({ showInfo: vi.fn(), showError: vi.fn() }));
vi.mock("#renderer/lib/toast", () => toast);
const openPath = vi.hoisted(() => vi.fn());
vi.mock("#renderer/lib/platform-system", () => ({
  platformSystem: () => ({ openPath }),
}));
vi.mock("#renderer/lib/i18n", () => ({ i18n: { t: (key: string) => key } }));

const client = {} as AppClient;

describe("openHostPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ outcome: "opened" }, null, null],
    [
      { outcome: "revealed", reason: "outside" },
      "showInfo",
      "openFile.revealedOutside",
    ],
    [
      { outcome: "revealed", reason: "executable" },
      "showInfo",
      "openFile.revealed",
    ],
    [{ outcome: "revealed" }, "showInfo", "openFile.revealed"],
    [
      { outcome: "refused", reason: "missing" },
      "showError",
      "openFile.refusedMissing",
    ],
    [
      { outcome: "refused", reason: "invalid" },
      "showError",
      "openFile.refusedInvalid",
    ],
    [
      { outcome: "refused", reason: "outside" },
      "showError",
      "openFile.refusedOutside",
    ],
  ] as const)("%o → %s %s", async (result, kind, key) => {
    openPath.mockResolvedValueOnce(result);
    await openHostPath(client, "/home/u/Desktop/budget.xlsx");
    expect(openPath).toHaveBeenCalledWith({
      path: "/home/u/Desktop/budget.xlsx",
    });
    if (kind == null) {
      expect(toast.showInfo).not.toHaveBeenCalled();
      expect(toast.showError).not.toHaveBeenCalled();
    } else expect(toast[kind]).toHaveBeenCalledWith(key);
  });

  it("says it could not open the file when the host call fails", async () => {
    openPath.mockRejectedValueOnce(new Error("gone"));
    await openHostPath(client, "/x");
    expect(toast.showError).toHaveBeenCalledWith("openFile.failed");
  });
});
