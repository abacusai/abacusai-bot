/**
 * R1-T6 and the jsdom half of R1-T24: the shell at each width band with the
 * controllable matchMedia. Real geometry (rects, env(), CSS.supports) is the
 * Electron screenshot run's (scripts/screenshots-next.mjs).
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePrefs } from "#next/data/fixture-db/rows";
import {
  defaultSeed,
  renderApp,
  type AppHarness,
} from "#next/test-support/app-harness";
import { setViewportWidth } from "#next/test-support/media";

import { HOVER_INTENT_MS, shellStore } from "./shell-store";
import { useTopBarStatusText } from "./top-bar-slots";

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
  (
    harness as (AppHarness & { view?: { unmount(): void } }) | null
  )?.view?.unmount();
  await harness?.cleanup();
  harness = null;
});

const shell = () => document.querySelector<HTMLElement>('[data-slot="shell"]')!;

const at = async (width: number, path: string, seed = defaultSeed()) => {
  setViewportWidth(width);
  harness = await renderApp(path, { seed });
  if (path.startsWith("/bots/"))
    await screen.findByTestId(path === "/bots/new" ? "bot-start" : "bot-chat");
  else
    await waitFor(() =>
      expect(document.querySelector('[data-slot="shell"]')).toBeTruthy()
    );
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

  it("shows no status unless a route sets one (V4)", async () => {
    await at(1280, "/bots/new");
    expect(document.querySelector('[data-slot="topbar-status"]')).toBeNull();
    await act(async () => {
      await harness!.router.navigate({ to: "/bots/chief-of-staff" } as never);
    });
    expect(document.querySelector('[data-slot="topbar-status"]')).toBeNull();
    expect(
      document.querySelector('[data-slot="bot-identity-status"]')?.textContent
    ).toBe(defaultSeed().bots![0]!.title);
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("hides the status text at md and folds actions into ⋯ at sm", async () => {
    await at(1280, "/bots/chief-of-staff");
    const Status = () => {
      useTopBarStatusText("Running");
      return null;
    };
    const status = render(<Status />);
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="topbar-status"]')?.textContent
      ).toBe("Running")
    );
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
    status.unmount();
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

const paneScroll = () =>
  document.querySelector<HTMLElement>('[data-slot="pane-scroll"]')!;
const navigate = async (options: Record<string, unknown>) => {
  await act(async () => {
    await harness!.router.navigate(options as never);
  });
};
const rail = () => document.querySelector<HTMLElement>('[data-slot="rail"]')!;
const railLink = (area: string) =>
  rail().querySelector<HTMLAnchorElement>(`a[data-area="${area}"]`)!;

describe("the pane keeps its instance (Codex #3, Claude #1)", () => {
  it("across panel open/close at xl and crossing 1100 with a tab open", async () => {
    await at(1280, "/sessions/review-prs");
    const node = paneScroll();
    const content = node.firstElementChild;
    node.scrollTop = 120;
    const check = () => {
      expect(paneScroll()).toBe(node);
      expect(paneScroll().firstElementChild).toBe(content);
      expect(paneScroll().scrollTop).toBe(120);
    };
    await navigate({ to: ".", search: { tab: "terminal" } });
    expect(
      document.querySelector('[data-slot="side-panel"][data-mode="layout"]')
    ).not.toBeNull();
    check();
    act(() => setViewportWidth(1000));
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="drawer-popup"]')
      ).not.toBeNull()
    );
    check();
    act(() => setViewportWidth(1280));
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="side-panel"][data-mode="layout"]')
      ).not.toBeNull()
    );
    check();
    await navigate({ to: ".", search: {} });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="side-panel"]')).toBeNull()
    );
    check();
  });
});

describe("the floating sidebar", () => {
  it("opens from the keyboard where the band forces floating, with focus inside (Codex #7)", async () => {
    await at(820, "/sessions/new");
    expect(shell().dataset.sidebar).toBe("floating");
    const toggle = screen.getByTestId("sidebar-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.focus();
    fireEvent.click(toggle);
    const floating = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-slot="sidebar-floating"]'
      );
      expect(node).not.toBeNull();
      return node!;
    });
    await waitFor(() =>
      expect(floating.contains(document.activeElement)).toBe(true)
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The preference is untouched: growing the window restores the user's.
    expect(harness!.db.prefs.rows.get("app")?.sidebar.pinned).toBe(true);
    // Focus inside keeps it open past the pointer grace.
    fireEvent.pointerLeave(floating);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(shellStore.state.floating.open).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(shellStore.state.floating.open).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it("a hover followed at once by navigation never reopens it on the next page (Codex #8)", async () => {
    const seed = defaultSeed();
    seed.prefs = fixturePrefs({
      sidebar: { pinned: false, openSection: null },
    });
    await at(1280, "/bots/new", seed);
    expect(shell().dataset.sidebar).toBe("floating");
    fireEvent.pointerOver(rail());
    await navigate({ to: "/sessions/new" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOVER_INTENT_MS + 80));
    });
    expect(shellStore.state.floating.open).toBe(false);
  });

  it("a hover pending when the rail unmounts never opens it later (Claude #15)", async () => {
    const seed = defaultSeed();
    seed.prefs = fixturePrefs({
      sidebar: { pinned: false, openSection: null },
    });
    await at(1280, "/bots/new", seed);
    fireEvent.pointerOver(rail());
    await navigate({ to: "/__ui" });
    expect(document.querySelector('[data-slot="rail"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOVER_INTENT_MS + 80));
    });
    expect(shellStore.state.floating.open).toBe(false);
  });
});

describe("the rail's last location (Claude #6)", () => {
  it("is a route location: pathname + search, never an href in `to`", async () => {
    await at(1280, "/sessions/review-prs?tab=terminal");
    await navigate({ to: "/bots/new" });
    const link = railLink("sessions");
    expect(link.getAttribute("href")).toBe("/sessions/review-prs?tab=terminal");
    const stored = shellStore.state.lastLocationByArea.sessions!;
    expect(stored).toEqual({
      pathname: "/sessions/review-prs",
      search: { tab: "terminal" },
    });
    const built = harness!.router.buildLocation({
      to: stored.pathname,
      search: stored.search,
    } as never);
    expect(built.pathname).toBe("/sessions/review-prs");
    expect(harness!.router.getMatchedRoutes(built.pathname)[2]?.id).toBe(
      "/_shell/(sessions)/sessions/$sessionId"
    );
    fireEvent.click(link);
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(
        "/sessions/review-prs"
      )
    );
    expect(harness!.router.state.location.search).toEqual({ tab: "terminal" });
  });

  it("remembers the background of a masked pop-up, not the pop-up", async () => {
    await at(1280, "/routines");
    await navigate({ to: "/routines/new" });
    await navigate({ to: "/bots/new" });
    expect(railLink("routines").getAttribute("href")).toBe("/routines");
    fireEvent.click(railLink("routines"));
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/routines")
    );
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });
});

describe("the title bar", () => {
  it("enables Forward only when history has an entry ahead (Claude #16)", async () => {
    await at(1280, "/bots/new");
    const forward = () => screen.getByRole("button", { name: "Forward" });
    expect(forward()).toHaveProperty("disabled", true);
    await navigate({ to: "/sessions/new" });
    expect(forward()).toHaveProperty("disabled", true);
    await act(async () => {
      harness!.router.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => expect(forward()).toHaveProperty("disabled", false));
    await navigate({ to: "/routines" });
    await waitFor(() => expect(forward()).toHaveProperty("disabled", true));
  });

  it("the panel toggle (and ⌘⌥B) reopens the area's last tab (Claude #19)", async () => {
    await at(1280, "/sessions/review-prs");
    await navigate({ to: ".", search: { tab: "files" } });
    const toggle = screen.getByTestId("panel-toggle");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(harness!.router.state.location.search).not.toHaveProperty("tab")
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(harness!.router.state.location.search).toEqual({ tab: "files" })
    );
  });

  it("panel tabs are borderless chips at the bar's control height (V7)", async () => {
    await at(1280, "/sessions/review-prs?tab=terminal");
    const tabs = within(
      document.querySelector<HTMLElement>('[data-slot="topbar"]')!
    ).getAllByRole("tab");
    for (const tab of tabs) {
      expect(tab.className).toContain("h-7");
      expect(tab.className).toContain("border-0");
    }
  });
});

describe("loading", () => {
  it("a bot route whose table failed to load shows the sidebar's Retry, not Not found (Claude #20)", async () => {
    setViewportWidth(1280);
    harness = await renderApp("/bots/chief-of-staff", {
      beforeRender: (db) => {
        db.bots.failSnapshot = new Error("UNAVAILABLE");
      },
    });
    await screen.findAllByRole("button", { name: "Retry" });
    expect(screen.queryByText("Not found")).toBeNull();
    expect(harness.router.state.location.pathname).toBe("/bots/chief-of-staff");
  });

  it("the closed command menu adds no bots subscription beyond global needs-you", async () => {
    await at(1280, "/sessions/new");
    await waitFor(() => expect(harness!.collections.bots.status).toBe("ready"));
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
