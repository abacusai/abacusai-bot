/**
 * R1-T6 and the jsdom half of R1-T24: the shell at each width band with the
 * controllable matchMedia. Real geometry (rects, env(), CSS.supports) is the
 * Electron screenshot run's (scripts/screenshots-next.mjs).
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePrefs } from "#next/data/fixture-db/rows";
import {
  defaultSeed,
  renderApp,
  type AppHarness,
} from "#next/test-support/app-harness";
import { setViewportWidth } from "#next/test-support/media";

vi.mock("#next/ui/resizable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#next/ui/resizable")>();
  // Record the props the shell passes to the panel (sizes are pixels, v4).
  const panels: Array<Record<string, unknown>> = [];
  const ResizablePanel = (props: Record<string, unknown>) => {
    panels.push(props);
    return (
      <actual.ResizablePanel
        {...(props as Parameters<typeof actual.ResizablePanel>[0])}
      />
    );
  };
  return { ...(actual as object), ResizablePanel, __panels: panels };
});

let harness: AppHarness | null = null;
beforeEach(() => setViewportWidth(1280));
afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const shell = () => document.querySelector<HTMLElement>('[data-slot="shell"]')!;

const at = async (width: number, path: string, seed = defaultSeed()) => {
  setViewportWidth(width);
  harness = await renderApp(path, { seed });
  await screen.findAllByTestId("empty-state");
  return harness;
};

describe("ShellLayout", () => {
  it("mirrors the band to html[data-band] and follows resizes", async () => {
    await at(1280, "/bots/new");
    expect(document.documentElement.dataset.band).toBe("xl");
    act(() => setViewportWidth(1099));
    await waitFor(() =>
      expect(document.documentElement.dataset.band).toBe("lg")
    );
    act(() => setViewportWidth(899));
    await waitFor(() =>
      expect(document.documentElement.dataset.band).toBe("sm")
    );
  });

  it("puts the side panel in layout at xl with pixel sizes, persisted after the debounce", async () => {
    const seed = defaultSeed();
    seed.prefs = fixturePrefs({ panes: { "side-panel": 420 } });
    await at(1280, "/sessions/review-prs?tab=terminal", seed);
    const panel = document.querySelector(
      '[data-slot="side-panel"][data-mode="layout"]'
    );
    expect(panel).not.toBeNull();
    const { __panels } = (await import("#next/ui/resizable")) as unknown as {
      __panels: Array<Record<string, unknown>>;
    };
    const sidePanel = __panels.filter((p) => p.id === "side-panel").at(-1)!;
    const pane = __panels.filter((p) => p.id === "pane").at(-1)!;
    expect(sidePanel.minSize).toBe(360);
    expect(pane.minSize).toBe(360);
    expect(sidePanel.defaultSize).toBe(420);
    vi.useFakeTimers();
    try {
      act(() => {
        (
          sidePanel.onResize as (size: {
            inPixels: number;
            asPercentage: number;
          }) => void
        )({
          inPixels: 380.4,
          asPercentage: 40,
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(harness!.db.prefs.rows.get("app")?.panes["side-panel"]).toBe(380)
    );
    expect(
      document.querySelector('[data-slot="topbar"] [role="tablist"]')
    ).not.toBeNull();
  });

  it("uses a non-modal drawer with data-side-panel below xl, and a scrim only there", async () => {
    await at(1000, "/sessions/review-prs?tab=terminal");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="drawer-popup"]')
      ).not.toBeNull()
    );
    const popup = document.querySelector<HTMLElement>(
      '[data-slot="drawer-popup"]'
    )!;
    expect(popup.hasAttribute("data-side-panel")).toBe(true);
    expect(document.querySelector('[data-slot="drawer-overlay"]')).toBeNull();
    expect(
      document
        .querySelector('[data-slot="drawer-viewport"]')
        ?.getAttribute("data-modal")
    ).toBe("false");
    expect(
      document.querySelector('[data-slot="side-panel-scrim"]')
    ).not.toBeNull();
    fireEvent.click(document.querySelector('[data-slot="side-panel-scrim"]')!);
    await waitFor(() =>
      expect(harness!.router.state.location.search).not.toHaveProperty("tab")
    );
  });

  it("has no scrim at xl", async () => {
    await at(1280, "/sessions/review-prs?tab=terminal");
    expect(document.querySelector('[data-slot="side-panel-scrim"]')).toBeNull();
  });

  it("sets --sidebar-occupied-w to 280, 88 or 0 by layout state", async () => {
    await at(1280, "/bots/new");
    expect(shell().style.getPropertyValue("--sidebar-occupied-w")).toBe(
      "280px"
    );
    act(() => setViewportWidth(820));
    await waitFor(() =>
      expect(shell().style.getPropertyValue("--sidebar-occupied-w")).toBe(
        "88px"
      )
    );
    expect(document.querySelector('[data-slot="bots-strip"]')).not.toBeNull();
    await act(async () => {
      await harness!.router.navigate({ to: "/sessions/new" } as never);
    });
    await waitFor(() =>
      expect(shell().style.getPropertyValue("--sidebar-occupied-w")).toBe("0px")
    );
  });

  it("unpins sessions at sm without writing prefs, and restores on growth", async () => {
    await at(820, "/sessions/new");
    expect(shell().dataset.sidebar).toBe("floating");
    expect(harness!.db.prefs.rows.get("app")?.sidebar.pinned).toBe(true);
    act(() => setViewportWidth(1200));
    await waitFor(() => expect(shell().dataset.sidebar).toBe("pinned"));
  });

  it("hides the status text at md and folds actions into ⋯ at sm", async () => {
    await at(1280, "/bots/chief-of-staff");
    expect(
      document.querySelector('[data-slot="topbar-status"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-slot="topbar-actions"]')
    ).not.toBeNull();
    act(() => setViewportWidth(950));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="topbar-status"]')).toBeNull()
    );
    act(() => setViewportWidth(850));
    await waitFor(() => expect(screen.getByTestId("topbar-more")).toBeTruthy());
    expect(document.querySelector('[data-slot="topbar-actions"]')).toBeNull();
  });

  it("shows the app name only while pinned; ⌘B-equivalent toggle writes prefs", async () => {
    await at(1280, "/bots/new");
    expect(
      document.querySelector('[data-slot="topbar-app-name"]')
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    await waitFor(() =>
      expect(harness!.db.prefs.rows.get("app")?.sidebar.pinned).toBe(false)
    );
    await waitFor(() =>
      expect(document.querySelector('[data-slot="topbar-app-name"]')).toBeNull()
    );
  });
});
