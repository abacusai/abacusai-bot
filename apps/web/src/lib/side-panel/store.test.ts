import { beforeEach, describe, expect, it } from "vitest";

import {
  activatePanelTab,
  closePanelTab,
  cyclePanelTab,
  openPanelTab,
  panelScope,
  panelScopeKey,
  panelStore,
  reorderPanelTabs,
  reopenPanelTab,
  resetPanelStore,
  setPanelOpen,
  setPanelExpanded,
  togglePanel,
  updatePanelTab,
} from "./store";

const key = "bots:b1";

beforeEach(() => resetPanelStore());

describe("panel store", () => {
  it("scopes per bot in the bots area and per area elsewhere", () => {
    expect(panelScopeKey("bots", "b1")).toBe("bots:b1");
    expect(panelScopeKey("bots")).toBe("area:bots");
    expect(panelScopeKey("sessions", "b1")).toBe("area:sessions");
    expect(panelScopeKey(undefined)).toBeNull();
    expect(panelScope(null)).toEqual({ open: false, tabs: [], active: null });
  });

  it("opens a single-instance kind once and refocuses it", () => {
    const first = openPanelTab(key, { kind: "details" });
    openPanelTab(key, { kind: "memory" });
    const again = openPanelTab(key, { kind: "details" });
    expect(again).toBe(first);
    const scope = panelScope(key);
    expect(scope.open).toBe(true);
    expect(scope.tabs.map((tab) => tab.kind)).toEqual(["details", "memory"]);
    expect(scope.active).toBe(first);
  });

  it("allows several browser and files tabs, reusing one with the same url or path", () => {
    const a = openPanelTab(key, { kind: "browser", url: "https://a.test" });
    const b = openPanelTab(key, { kind: "browser", url: "https://b.test" });
    const again = openPanelTab(key, { kind: "browser", url: "https://a.test" });
    const fresh = openPanelTab(key, { kind: "browser" }, { fresh: true });
    expect(a).not.toBe(b);
    expect(again).toBe(a);
    expect(fresh).not.toBe(a);
    openPanelTab(key, { kind: "files", path: "/w/a.md" });
    openPanelTab(key, { kind: "files", path: "/w/b.md" });
    expect(
      panelScope(key)
        .tabs.filter((tab) => tab.kind === "files")
        .map((tab) => tab.path)
    ).toEqual(["/w/a.md", "/w/b.md"]);
  });

  it("closing activates the right neighbour, then the left; the last closes the panel", () => {
    const a = openPanelTab(key, { kind: "details" });
    const b = openPanelTab(key, { kind: "memory" });
    const c = openPanelTab(key, { kind: "files" });
    activatePanelTab(key, b);
    closePanelTab(key, b);
    expect(panelScope(key).active).toBe(c);
    closePanelTab(key, c);
    expect(panelScope(key).active).toBe(a);
    expect(panelScope(key).open).toBe(true);
    closePanelTab(key, a);
    expect(panelScope(key)).toMatchObject({
      open: false,
      tabs: [],
      active: null,
    });
  });

  it("reorders by id list and cycles with wrap-around", () => {
    const a = openPanelTab(key, { kind: "details" });
    const b = openPanelTab(key, { kind: "memory" });
    const c = openPanelTab(key, { kind: "files" });
    reorderPanelTabs(key, [c, a, b]);
    expect(panelScope(key).tabs.map((tab) => tab.id)).toEqual([c, a, b]);
    // A partial list never drops tabs.
    reorderPanelTabs(key, [a]);
    expect(panelScope(key).tabs).toHaveLength(3);
    activatePanelTab(key, b);
    cyclePanelTab(key, 1);
    expect(panelScope(key).active).toBe(c);
    cyclePanelTab(key, -1);
    expect(panelScope(key).active).toBe(b);
  });

  it("the toggle closes an open panel, reopens on its tabs, else on the area's first kind", () => {
    togglePanel(key, "bots");
    expect(panelScope(key).tabs.map((tab) => tab.kind)).toEqual(["details"]);
    togglePanel(key, "bots");
    expect(panelScope(key).open).toBe(false);
    expect(panelScope(key).tabs).toHaveLength(1);
    togglePanel(key, "bots");
    expect(panelScope(key).open).toBe(true);
    togglePanel("area:sessions", "sessions");
    expect(panelScope("area:sessions").tabs[0]?.kind).toBe("changes");
  });

  it("keeps the open state apart from the tabs, and patches a tab in place", () => {
    const id = openPanelTab(key, { kind: "browser" });
    setPanelOpen(key, false);
    expect(panelScope(key).tabs).toHaveLength(1);
    updatePanelTab(key, id, { url: "https://x.test", title: "X" });
    expect(panelScope(key).tabs[0]).toMatchObject({
      url: "https://x.test",
      title: "X",
    });
    const before = panelStore.state;
    updatePanelTab(key, id, { url: "https://x.test" });
    expect(panelStore.state).toBe(before);
  });

  it("persists to sessionStorage", () => {
    openPanelTab(key, { kind: "details" });
    panelStore.flush();
    const raw = JSON.parse(
      sessionStorage.getItem("abacusai-bot:abacus.shell.panel") ?? "{}"
    ) as Record<string, { open: boolean }>;
    expect(raw[key]?.open).toBe(true);
  });
});

it("expanded Chat cannot close, remains focused across toggles and returns to tools on collapse", () => {
  const details = openPanelTab(key, { kind: "details" });
  setPanelExpanded(key, true);
  activatePanelTab(key, "chat");
  expect(panelScope(key).active).toBe("chat");
  closePanelTab(key, "chat");
  expect(panelScope(key).active).toBe("chat");
  setPanelOpen(key, false);
  setPanelOpen(key, true);
  expect(panelScope(key).active).toBe("chat");
  setPanelExpanded(key, false);
  expect(panelScope(key).active).toBe(details);
});

it("reopens a closed tab with its metadata and a fresh resource identity", () => {
  const id = openPanelTab(key, {
    kind: "browser",
    url: "https://example.test",
    title: "Example",
  });
  closePanelTab(key, id);
  const reopened = reopenPanelTab(key);
  expect(reopened).not.toBe(id);
  expect(panelScope(key).tabs[0]).toMatchObject({
    url: "https://example.test",
    title: "Example",
  });
  expect(reopenPanelTab(key)).toBeNull();
});
