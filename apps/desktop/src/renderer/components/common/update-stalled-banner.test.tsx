import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The banner that is left after the update UI stopped saying everything twice.
 *
 * An ordinary update is the title bar's pill and nothing else. This bar is for
 * the one state the pill cannot express — the install was handed off and the
 * app never quit — and the thing worth pinning is that it appears for exactly
 * that and nothing else.
 */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { UpdateStalledBanner } = await import("./update-stalled-banner");

type Status = Record<string, unknown>;

let listener: ((status: Status) => void) | null = null;

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
      onStatusChange: (callback: (next: Status) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
    },
  };

  return render(<UpdateStalledBanner />);
};

beforeEach(() => {
  listener = null;
});

describe("UpdateStalledBanner", () => {
  it("stays out of the way of an update that is going fine", async () => {
    const { container } = mountWith(
      status({ downloaded: true, updateInfo: { version: "1.0.5" } })
    );

    // A downloaded update is the pill's business — a second announcement here
    // is what this component was cut down to stop doing.
    await waitFor(() => {
      expect(container.querySelector("[data-id='update-banner']")).toBeNull();
    });
  });

  it("says what to do when the install could not restart the app", async () => {
    const { container } = mountWith(status({ installStalled: true }));

    await waitFor(() => {
      expect(
        container.querySelector("[data-id='update-banner-stalled-msg']")
          ?.textContent
      ).toBe("updateBanner.stalled");
    });
  });

  it("takes the bar back down if a later status clears the stall", async () => {
    const { container } = mountWith(status({ installStalled: true }));

    await waitFor(() => {
      expect(
        container.querySelector("[data-id='update-banner']")
      ).not.toBeNull();
    });

    listener?.(status({ installStalled: false }));

    await waitFor(() => {
      expect(container.querySelector("[data-id='update-banner']")).toBeNull();
    });
  });
});
