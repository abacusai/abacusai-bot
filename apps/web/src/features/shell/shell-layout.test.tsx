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

import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import {
  defaultSeed,
  renderApp,
  type AppHarness,
} from "#renderer/test-support/app-harness";
import { setViewportWidth } from "#renderer/test-support/media";

import {
  openPanelTab,
  panelScope,
  panelScopeKey,
  setPanelOpen,
  setPanelExpanded,
} from "./panel-store";
import { HOVER_INTENT_MS, shellStore } from "./shell-store";
import { useTopBarActions, useTopBarStatusText } from "./top-bar-slots";

vi.mock("#renderer/ui/resizable", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#renderer/ui/resizable")>();
  // Record the props the shell passes to the panel (sizes are pixels, v4).
  const panels: Array<Record<string, unknown>> = [];
  const groups: Array<Record<string, unknown>> = [];
  const ResizablePanelGroup = (props: Record<string, unknown>) => {
    groups.push(props);
    return (
      <actual.ResizablePanelGroup
        {...(props as Parameters<typeof actual.ResizablePanelGroup>[0])}
      />
    );
  };
  const ResizablePanel = (props: Record<string, unknown>) => {
    panels.push(props);
    return (
      <actual.ResizablePanel
        {...(props as Parameters<typeof actual.ResizablePanel>[0])}
      />
    );
  };
  return {
    ...(actual as object),
    ResizablePanel,
    ResizablePanelGroup,
    __panels: panels,
    __groups: groups,
  };
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
  it.each([
    "/bots/new",
    "/bots/missing-bot",
    "/bots/chief-of-staff/edit",
    "/sessions/new",
    "/routines",
    "/artifacts",
    "/library/connectors",
    "/settings/general",
  ])("has no panel toggle on %s", async (path) => {
    setViewportWidth(1280);
    harness = await renderApp(path);
    await waitFor(() => expect(shell()).toBeTruthy());
    expect(screen.queryByTestId("panel-toggle")).toBeNull();
  });

  it("keeps session tools in the title bar, remembers each session and reflects toggling", async () => {
    const seed = defaultSeed();
    const second = seed.sessions!.find(
      (row) =>
        row.id !== "review-prs" && !row.editorFor && row.owner?.kind !== "bot"
    )!;
    await at(1280, "/sessions/review-prs?tab=files", seed);
    const top = () =>
      within(document.querySelector<HTMLElement>('[data-slot="topbar"]')!);
    await waitFor(() =>
      expect(
        top().getByRole("tab", { name: "Files" }).getAttribute("aria-selected")
      ).toBe("true")
    );
    expect(
      top()
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["Changes", "Terminal", "Files", "Browser"]);
    expect(
      screen.getByTestId("panel-toggle").getAttribute("aria-pressed")
    ).toBe("true");
    fireEvent.click(top().getByRole("tab", { name: "Changes" }));
    await waitFor(() =>
      expect(
        top()
          .getByRole("tab", { name: "Changes" })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    await navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: second.id },
      search: {},
    });
    expect(
      screen.getByTestId("panel-toggle").getAttribute("aria-pressed")
    ).toBe("false");
    await navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: "review-prs" },
      search: {},
    });
    await waitFor(() =>
      expect(
        top()
          .getByRole("tab", { name: "Changes" })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    const content = document.querySelector('[data-dock-pane="changes"]');
    fireEvent.click(screen.getByTestId("panel-toggle"));
    await waitFor(() =>
      expect(
        screen.getByTestId("panel-toggle").getAttribute("aria-pressed")
      ).toBe("false")
    );
    expect(document.querySelector('[data-dock-pane="changes"]')).toBe(content);
    fireEvent.click(screen.getByTestId("panel-toggle"));
    await waitFor(() =>
      expect(
        top()
          .getByRole("tab", { name: "Changes" })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    expect(document.querySelector('[data-dock-pane="changes"]')).toBe(content);
    top().getByRole("tab", { name: "Changes" }).focus();
    fireEvent.keyDown(top().getByRole("tab", { name: "Changes" }), {
      key: "End",
    });
    await waitFor(() =>
      expect(
        top()
          .getByRole("tab", { name: "Browser" })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    expect(document.activeElement).toBe(
      top().getByRole("tab", { name: "Browser" })
    );
  });

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
    await at(1280, "/bots/chief-of-staff?tab=details", seed);
    const panel = document.querySelector(
      '[data-slot="side-panel"][data-mode="layout"]'
    );
    expect(panel).not.toBeNull();
    const { __panels, __groups } =
      (await import("#renderer/ui/resizable")) as unknown as {
        __panels: Array<Record<string, unknown>>;
        __groups: Array<Record<string, unknown>>;
      };
    const sidePanel = __panels.filter((p) => p.id === "side-panel").at(-1)!;
    const pane = __panels.filter((p) => p.id === "pane").at(-1)!;
    expect(sidePanel.minSize).toBe(360);
    // jsdom measures nothing: the absolute cap applies.
    expect(sidePanel.maxSize).toBe(960);
    expect(pane.minSize).toBe(360);
    expect(sidePanel.defaultSize).toBe(420);
    // Only the debounce's timers: a faked animation frame would strand
    // Motion's frame loop (the avatars animate) for every later test.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
        (
          __groups.findLast((group) => group.className === "gap-0")!
            .onLayoutChanged as (
            layout: unknown,
            meta: { isUserInteraction: boolean }
          ) => void
        )({}, { isUserInteraction: true });
      });
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(
        harness!.db.prefs.rows.get("app")?.panes["panel.bots:chief-of-staff"]
      ).toBe(380)
    );
    expect(
      document.querySelector('[data-slot="topbar"] [role="tablist"]')
    ).not.toBeNull();
  });

  it("does not save automatic panel constraint changes as a user resize", async () => {
    const seed = defaultSeed();
    seed.prefs = fixturePrefs({ panes: { "side-panel": 600 } });
    await at(1280, "/bots/chief-of-staff?tab=details", seed);
    const { __panels, __groups } =
      (await import("#renderer/ui/resizable")) as unknown as {
        __panels: Array<Record<string, unknown>>;
        __groups: Array<Record<string, unknown>>;
      };
    const panel = __panels.findLast((item) => item.id === "side-panel")!;
    const group = __groups.findLast((item) => item.className === "gap-0")!;
    act(() => {
      (panel.onResize as (size: { inPixels: number }) => void)({
        inPixels: 360,
      });
      (
        group.onLayoutChanged as (
          layout: unknown,
          meta: { isUserInteraction: boolean }
        ) => void
      )({}, { isUserInteraction: false });
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness!.db.prefs.rows.get("app")?.panes["side-panel"]).toBe(600);
  });

  it("clamps a stored panel width outside 360–960 and never writes one outside it", async () => {
    const seed = defaultSeed();
    seed.prefs = fixturePrefs({ panes: { "side-panel": 1400 } });
    await at(1280, "/bots/chief-of-staff?tab=details", seed);
    const { __panels, __groups } =
      (await import("#renderer/ui/resizable")) as unknown as {
        __panels: Array<Record<string, unknown>>;
        __groups: Array<Record<string, unknown>>;
      };
    const sidePanel = __panels.filter((p) => p.id === "side-panel").at(-1)!;
    expect(sidePanel.defaultSize).toBe(960);
    // As above: the debounce's timers only.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        (
          sidePanel.onResize as (size: {
            inPixels: number;
            asPercentage: number;
          }) => void
        )({ inPixels: 120, asPercentage: 10 });
        (
          __groups.findLast((group) => group.className === "gap-0")!
            .onLayoutChanged as (
            layout: unknown,
            meta: { isUserInteraction: boolean }
          ) => void
        )({}, { isUserInteraction: true });
      });
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(
        harness!.db.prefs.rows.get("app")?.panes["panel.bots:chief-of-staff"]
      ).toBe(360)
    );
  });

  it("uses a non-modal drawer with data-side-panel below the split minimum, and a scrim only there", async () => {
    await at(800, "/bots/chief-of-staff?tab=details");
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
      expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull()
    );
    // Closing keeps the tabs; only `open` flips.
    const scope = panelScope(panelScopeKey("bots", "chief-of-staff"));
    expect(scope.open).toBe(false);
    expect(scope.tabs.map((tab) => tab.kind)).toEqual(["details"]);
  });

  it("consumes ?tab= as a deep link: the panel opens from the store and the URL loses it", async () => {
    await at(1280, "/bots/chief-of-staff?tab=memory");
    await waitFor(() =>
      expect(harness!.router.state.location.search).not.toHaveProperty("tab")
    );
    const scope = panelScope(panelScopeKey("bots", "chief-of-staff"));
    expect(scope.open).toBe(true);
    expect(scope.tabs.map((tab) => tab.kind)).toEqual(["memory"]);
    expect(
      document.querySelector('[data-slot="side-panel"][data-mode="layout"]')
    ).not.toBeNull();
  });

  it("keeps the panel across the check-in pop-up and the editor (the owner's two complaints)", async () => {
    await at(1280, "/bots/chief-of-staff?tab=details");
    const panel = () =>
      document.querySelector('[data-slot="side-panel"][data-mode="layout"]');
    await waitFor(() => expect(panel()).not.toBeNull());
    // The check-in editor is a masked pop-up over the chat: the panel stays.
    await navigate({
      to: "/bots/$botId/check-in",
      params: { botId: "chief-of-staff" },
    });
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    );
    expect(panel()).not.toBeNull();
    // The editor takes the pane; the panel hides but its state is untouched.
    await navigate({
      to: "/bots/$botId/edit",
      params: { botId: "chief-of-staff" },
    });
    await waitFor(() => expect(panel()).toBeNull());
    expect(panelScope(panelScopeKey("bots", "chief-of-staff")).open).toBe(true);
    // Cancel: back to the chat with the panel as it was, on the same tab.
    await navigate({ to: "/bots/$botId", params: { botId: "chief-of-staff" } });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(
      document.querySelector(
        '[data-slot="topbar"] [role="tab"][aria-selected="true"]'
      )?.textContent
    ).toBe("Details");
  });

  it("has no scrim at xl", async () => {
    await at(1280, "/bots/chief-of-staff?tab=details");
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
      // A route action, so the bar has something to fold.
      useTopBarActions([{ id: "export", label: "Export", onSelect() {} }]);
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

  it("shows the app name only while pinned, the brand mark always; ⌘B-equivalent toggle writes prefs", async () => {
    await at(1280, "/bots/new");
    const brand = () =>
      document.querySelector(
        '[data-slot="topbar-brand"] [data-slot="app-brand-mark"]'
      );
    expect(brand()).not.toBeNull();
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
    // Collapsed: the icon alone.
    expect(brand()).not.toBeNull();
  });

  it("keeps every rail label on one line and names each item by it", async () => {
    await at(1280, "/bots/new");
    for (const area of [
      "bots",
      "sessions",
      "routines",
      "artifacts",
      "library",
    ]) {
      const link = railLink(area);
      const label = link.querySelector<HTMLElement>("span:last-child")!;
      expect(label.className).toContain("whitespace-nowrap");
      expect(label.className).toContain("truncate");
      expect(link.hasAttribute("aria-label")).toBe(false);
    }
  });
});

describe("Rail: icons only (Settings › Appearance)", () => {
  const seedIconsOnly = (pinned: boolean) => {
    const seed = defaultSeed();
    const prefs = fixturePrefs({ sidebar: { pinned, openSection: null } });
    seed.prefs = {
      ...prefs,
      appearance: { ...prefs.appearance!, railIconsOnly: true },
    };
    return seed;
  };

  it("drops the labels, keeps the 48 px items and names them for assistive tech", async () => {
    await at(1280, "/bots/new", seedIconsOnly(true));
    expect(rail().dataset.iconsOnly).toBe("");
    const link = railLink("sessions");
    expect(link.textContent).toBe("");
    expect(link.getAttribute("aria-label")).toBe("Sessions");
    expect(link.className).toContain("size-(--rail-item)");
  });

  it("gives each item a tooltip while the sidebar is pinned, none while it floats", async () => {
    await at(1280, "/bots/new", seedIconsOnly(true));
    expect(railLink("sessions").dataset.slot).toBe("tooltip-trigger");
    expect(
      rail()
        .querySelector('a[aria-label="Settings"]')
        ?.getAttribute("data-slot")
    ).toBe("tooltip-trigger");
    // Unpinned: hovering the rail opens the floating sidebar instead.
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    await waitFor(() => expect(shell().dataset.sidebar).toBe("floating"));
    expect(railLink("sessions").dataset.slot).toBeUndefined();
    expect(railLink("sessions").getAttribute("aria-label")).toBe("Sessions");
  });

  it("labels stay with the pref off", async () => {
    await at(1280, "/bots/new");
    expect(rail().dataset.iconsOnly).toBeUndefined();
    expect(railLink("sessions").textContent).toBe("Sessions");
    expect(railLink("sessions").dataset.slot).toBeUndefined();
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
    await at(1280, "/bots/chief-of-staff");
    const node = paneScroll();
    const content = node.firstElementChild;
    node.scrollTop = 120;
    const check = () => {
      expect(paneScroll()).toBe(node);
      expect(paneScroll().firstElementChild).toBe(content);
      expect(paneScroll().scrollTop).toBe(120);
    };
    const key = panelScopeKey("bots", "chief-of-staff")!;
    act(() => {
      openPanelTab(key, { kind: "details" });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="side-panel"][data-mode="layout"]')
      ).not.toBeNull()
    );
    check();
    act(() => setViewportWidth(800));
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
    act(() => {
      setPanelOpen(key, false);
    });
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
    (harness as AppHarness & { view: { unmount(): void } }).view.unmount();
    expect(document.querySelector('[data-slot="rail"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOVER_INTENT_MS + 80));
    });
    expect(shellStore.state.floating.open).toBe(false);
  });
});

describe("the rail's last location (Claude #6)", () => {
  it("is a route location: pathname + search, never an href in `to`", async () => {
    await at(1280, "/sessions/review-prs?tab=terminal:test");
    await navigate({ to: "/bots/new" });
    const link = railLink("sessions");
    expect(link.getAttribute("href")).toBe(
      "/sessions/review-prs?tab=terminal%3Atest"
    );
    const stored = shellStore.state.lastLocationByArea.sessions!;
    expect(stored).toEqual({
      pathname: "/sessions/review-prs",
      search: { tab: "terminal:test" },
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
    expect(harness!.router.state.location.search).toEqual({
      tab: "terminal:test",
    });
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

  it("the panel toggle (and ⌘⌥B) reopens the sessions dock's last tab (Claude #19)", async () => {
    await at(1280, "/sessions/review-prs");
    await navigate({ to: ".", search: { tab: "files" } });
    const toggle = screen.getByTestId("panel-toggle");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(harness!.router.state.location.search).not.toHaveProperty("tab")
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("panel-toggle").getAttribute("aria-expanded")
      ).toBe("false")
    );
    fireEvent.click(screen.getByTestId("panel-toggle"));
    await waitFor(() =>
      expect(harness!.router.state.location.search).toEqual({ tab: "files" })
    );
  });

  it("reveals a forced floating primary sidebar without closing the Session tools", async () => {
    await at(1000, "/sessions/review-prs?tab=files");
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    await waitFor(() => expect(shellStore.state.floating.open).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Changes" })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    expect(shellStore.state.floating.open).toBe(true);
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    await waitFor(() => expect(shellStore.state.floating.open).toBe(false));
    expect(harness!.db.prefs.rows.get("app")?.sidebar.pinned).toBe(true);
  });

  it("the panel toggle reopens a bot's strip as it was, and the strip adds, closes and switches tabs", async () => {
    await at(1280, "/bots/chief-of-staff?tab=details");
    const key = panelScopeKey("bots", "chief-of-staff")!;
    const toggle = () => screen.getByTestId("panel-toggle");
    await waitFor(() =>
      expect(toggle().getAttribute("aria-expanded")).toBe("true")
    );
    act(() => {
      openPanelTab(key, { kind: "memory" });
    });
    const tabs = () =>
      within(document.querySelector<HTMLElement>('[data-slot="topbar"]')!)
        .getAllByRole("tab")
        .map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]);
    await waitFor(() =>
      expect(tabs()).toEqual([
        ["Details", "false"],
        ["Memory", "true"],
      ])
    );
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(toggle().getAttribute("aria-expanded")).toBe("false")
    );
    expect(panelScope(key).tabs).toHaveLength(2);
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(tabs()).toEqual([
        ["Details", "false"],
        ["Memory", "true"],
      ])
    );
    // Switch, then close the active one: its neighbour takes over.
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    await waitFor(() => expect(tabs()[0]?.[1]).toBe("true"));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Details" }), {
      key: "Backspace",
    });
    await waitFor(() => expect(tabs()).toEqual([["Memory", "true"]]));
    // "+" adds a second browser tab even with one open: a new-tab page.
    act(() => {
      openPanelTab(key, { kind: "browser" });
    });
    fireEvent.click(screen.getByTestId("panel-add-tab"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Browser" }));
    await waitFor(() =>
      expect(
        panelScope(key).tabs.filter((tab) => tab.kind === "browser")
      ).toHaveLength(2)
    );
  });

  it("offers every bot tool from the floating rail at narrow widths", async () => {
    await at(800, "/bots/chief-of-staff?tab=details");
    const key = panelScopeKey("bots", "chief-of-staff")!;
    const drawer = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-side-panel]");
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.click(within(drawer).getByTestId("panel-add-tab"));
    for (const name of ["Details", "Memory", "Files", "Browser"])
      expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Browser" }));
    await waitFor(() =>
      expect(panelScope(key).tabs.some((tab) => tab.kind === "browser")).toBe(
        true
      )
    );
    expect(within(drawer).getByTestId("panel-add-tab")).toBeTruthy();
  });

  it("keeps Chat reachable when an expanded Bots workspace falls back to a drawer", async () => {
    await at(800, "/bots/chief-of-staff?tab=details");
    const key = panelScopeKey("bots", "chief-of-staff")!;
    act(() => setPanelExpanded(key, true));
    fireEvent.click(await screen.findByRole("tab", { name: "Chat" }));
    await waitFor(() =>
      expect(document.querySelector("[data-side-panel]")).toBeNull()
    );
    expect(screen.getByTestId("bot-chat")).toBeTruthy();
    expect(panelScope(key).expanded).toBe(true);
    act(() => setViewportWidth(1280));
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-expanded]")).not.toBeNull()
    );
  });

  it("panel tabs are borderless chips at the bar's control height (V7)", async () => {
    await at(1280, "/bots/chief-of-staff?tab=details");
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
    // The menu (a command dialog) is not mounted; the page's own combobox,
    // the session composer's model chip, is.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[cmdk-input]")).toBeNull();
  });
});
