import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const { HomeUpdateBanner } = await import("./home-update-banner");

type Status = Record<string, unknown>;

const install = vi.fn(() => Promise.resolve({ success: true }));
const check = vi.fn(() => Promise.resolve({ success: true }));

const status = (over: Status = {}): Status => ({
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  ...over,
});

const mountWith = (initial: Status) => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  (window as unknown as { api: unknown }).api = {
    update: {
      getStatus: () => Promise.resolve(initial),
      onStatusChange: () => () => {},
      install,
      check,
    },
  };

  return render(<HomeUpdateBanner />);
};

beforeEach(() => {
  install.mockClear();
  check.mockClear();
});

describe("HomeUpdateBanner", () => {
  it("is not there at all when there is no update", async () => {
    const { container } = mountWith(status());

    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
  });

  it("offers the relaunch once the build is on disk", async () => {
    const { container } = mountWith(
      status({
        available: true,
        downloaded: true,
        updateInfo: { version: "1.0.6" },
      })
    );

    const button = await waitFor(() => {
      const node = container.querySelector<HTMLButtonElement>(
        "[data-id='home-update-banner-install']"
      );
      if (node == null) throw new Error("no install button");
      return node;
    });

    expect(container.textContent).toContain("updateBanner.title");

    button.click();
    expect(install).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(container.textContent).toContain("updatePill.installing");
    });
  });

  it("goes away when dismissed", async () => {
    const { container } = mountWith(
      status({
        available: true,
        downloaded: true,
        updateInfo: { version: "1.0.6" },
      })
    );

    const dismiss = await waitFor(() => {
      const node = container.querySelector<HTMLButtonElement>(
        "[data-id='home-update-banner-dismiss']"
      );
      if (node == null) throw new Error("no dismiss");
      return node;
    });
    dismiss.click();

    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
  });

  it("stands down for the surfaces that outrank it", async () => {
    for (const over of [{ criticalUpdate: true }, { installStalled: true }]) {
      const { container, unmount } = mountWith(
        status({ available: true, downloaded: true, ...over })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("offers a retry when the download died", async () => {
    const { container } = mountWith(
      status({ available: true, error: "net::ERR_NETWORK_CHANGED" })
    );

    const retry = await waitFor(() => {
      const node = container.querySelector<HTMLButtonElement>(
        "[data-id='home-update-banner-failed']"
      );
      if (node == null) throw new Error("no retry");
      return node;
    });
    retry.click();

    expect(check).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
  });
});
