import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The update, where it lives now: one strip above the composer.
 *
 * What is worth pinning is the restraint. It is absent when there is no
 * update — which is almost always — quiet while a download nobody can act on
 * runs, and only takes colour and a click target at the one moment a click
 * does something.
 */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const { ComposerUpdateStrip } = await import("./composer-update-strip");

type Status = Record<string, unknown>;

const install = vi.fn(() => Promise.resolve({ success: true }));
const check = vi.fn(() => Promise.resolve({ success: true }));

const status = (over: Status = {}): Status => ({
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
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

  return render(<ComposerUpdateStrip />);
};

beforeEach(() => {
  install.mockClear();
  check.mockClear();
});

describe("ComposerUpdateStrip", () => {
  it("is not there at all when there is no update", async () => {
    const { container } = mountWith(status());

    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
  });

  it("reports the download without offering anything to click", async () => {
    const { container } = mountWith(
      status({
        available: true,
        downloading: true,
        progress: {
          percent: 41.7,
          bytesPerSecond: 0,
          total: 0,
          transferred: 0,
        },
        updateInfo: { version: "1.0.6" },
      })
    );

    await waitFor(() => {
      expect(
        container.querySelector("[data-id='update-strip-downloading']")
      ).not.toBeNull();
    });
    // Rounded, not 41.7 — and no button, because nothing can be done yet.
    expect(container.textContent).toContain('{"percent":42}');
    expect(container.querySelector("button")).toBeNull();
    expect(
      container.querySelector<HTMLElement>("[data-id='update-strip-progress']")
        ?.style.width
    ).toBe("42%");
  });

  it("becomes a click target once the build is on disk", async () => {
    const { container } = mountWith(
      status({
        available: true,
        downloaded: true,
        updateInfo: { version: "1.0.6" },
      })
    );

    let strip: HTMLElement | null = null;
    await waitFor(() => {
      strip = container.querySelector("[data-id='update-strip']");
      expect(strip).not.toBeNull();
    });

    expect(container.textContent).toContain("updatePill.relaunch");
    // The version rides along as a trailing label rather than padding the strip's
    // own words.
    expect(container.textContent).toContain("1.0.6");

    strip!.click();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("stands down for the surfaces that outrank it", async () => {
    // A critical update has the blocking dialog; a stalled install has the
    // banner saying another click will not help. Neither wants a second voice.
    for (const over of [{ criticalUpdate: true }, { installStalled: true }]) {
      const { container, unmount } = mountWith(
        status({ available: true, downloaded: true, ...over })
      );
      // Give the initial fetch a chance to land before asserting absence.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("keeps saying it is restarting across a remount", async () => {
    // Switching sessions remounts the chat panel. The service reports
    // `installing` once the install is handed off, so a fresh mount must not
    // offer it again.
    const { container } = mountWith(
      status({
        available: true,
        downloaded: true,
        installing: true,
        updateInfo: { version: "1.0.6" },
      })
    );

    await waitFor(() => {
      expect(container.textContent).toContain("updatePill.installing");
    });
    container
      .querySelector<HTMLButtonElement>("[data-id='update-strip']")
      ?.click();
    expect(install).not.toHaveBeenCalled();
  });

  it("says it is restarting, and stops taking clicks", async () => {
    const { container } = mountWith(
      status({
        available: true,
        downloaded: true,
        updateInfo: { version: "1.0.6" },
      })
    );

    await waitFor(() => {
      expect(
        container.querySelector("[data-id='update-strip']")
      ).not.toBeNull();
    });

    const strip = container.querySelector<HTMLButtonElement>(
      "[data-id='update-strip']"
    )!;
    strip.click();

    await waitFor(() => {
      expect(container.textContent).toContain("updatePill.installing");
    });

    strip.click();
    expect(install).toHaveBeenCalledTimes(1);
  });
});

/**
 * A download that died.
 *
 * Reported from a real dump: a transfer killed by `net::ERR_NETWORK_CHANGED`
 * (moving between wifi and a VPN is enough) left the strip saying "41%" with a
 * spinner over it — for hours, across two more failed retries, until the app
 * was restarted. Two things were wrong: the service kept the last progress
 * figure after the transfer died, and the strip had no failed state to show even
 * if it had not.
 */
describe("when the download fails", () => {
  const failed = (over: Status = {}): Status =>
    status({
      available: true,
      downloading: false,
      error: "net::ERR_NETWORK_CHANGED",
      updateInfo: { version: "1.0.19" },
      ...over,
    });

  it("stops claiming a download is running", async () => {
    const { container } = mountWith(failed());

    await waitFor(() => {
      expect(
        container.querySelector('[data-id="update-strip-failed"]')
      ).toBeTruthy();
    });
    expect(
      container.querySelector('[data-id="update-strip-downloading"]')
    ).toBeNull();
    expect(container.textContent).not.toContain("downloading");
  });

  it("does not show a percentage from the transfer that died", async () => {
    // The service clears this now, but the strip must not resurrect it from a
    // status written by an older build either.
    const { container } = mountWith(
      failed({
        progress: {
          percent: 41.7,
          bytesPerSecond: 0,
          total: 0,
          transferred: 0,
        },
      })
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-id="update-strip-failed"]')
      ).toBeTruthy();
    });
    expect(container.textContent).not.toContain("41");
    expect(
      container.querySelector('[data-id="update-strip-progress"]')
    ).toBeNull();
  });

  it("offers a retry, which is the one thing the user can do", async () => {
    const { container } = mountWith(failed());

    const retry = await waitFor(() => {
      const node = container.querySelector('[data-id="update-strip-retry"]');
      if (node == null) throw new Error("no retry");

      return node as HTMLElement;
    });
    retry.click();

    expect(check).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
  });

  it("says it is retrying rather than offering a second click", async () => {
    const { container } = mountWith(failed({ checking: true }));

    await waitFor(() => {
      expect(container.textContent).toContain("updatePill.retrying");
    });
    expect(
      container.querySelector('[data-id="update-strip-retry"]')
    ).toHaveProperty("disabled", true);
  });

  it("gets out of the way once a retry succeeds", async () => {
    // An error left over from a previous attempt must not outrank a build
    // that has since landed on disk.
    const { container } = mountWith(
      failed({ downloaded: true, error: "net::ERR_NETWORK_CHANGED" })
    );

    await waitFor(() => {
      expect(container.querySelector('[data-id="update-strip"]')).toBeTruthy();
    });
    expect(
      container.querySelector('[data-id="update-strip-failed"]')
    ).toBeNull();
  });
});
