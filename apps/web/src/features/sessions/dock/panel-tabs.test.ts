import { expect, it } from "vitest";

import { dockLeaves } from "./dock-store";
import {
  panelTabsStore,
  openTab,
  updateTabs,
  updateTab,
  focusTab,
  reconcileTerminals,
} from "./panel-tabs-store";
it("preview eviction atomically removes tree references, prunes leaves and repairs last", () => {
  const key = "eviction";
  panelTabsStore.setState((s) => ({ ...s, [key]: { tabs: [], last: null } }));
  for (let i = 0; i < 50; i++)
    openTab(key, { ref: `preview:${i}`, title: `${i}` });
  updateTabs(key, (s) => ({
    ...s,
    last: "preview:0",
    tree: {
      kind: "split",
      id: "split",
      orientation: "horizontal",
      children: [
        { kind: "leaf", id: "old", tabs: ["preview:0"], active: "preview:0" },
        {
          kind: "leaf",
          id: "rest",
          tabs: s.tabs.slice(1).map((t) => t.ref),
          active: "preview:1",
        },
      ],
    },
  }));
  openTab(key, { ref: "preview:50", title: "50" });
  const state = panelTabsStore.state[key]!;
  expect(state.tabs).toHaveLength(50);
  expect(dockLeaves(state.tree!)).toHaveLength(1);
  expect(dockLeaves(state.tree!)[0]!.tabs).not.toContain("preview:0");
  expect(state.last).toBe("preview:50");
  expect(dockLeaves(state.tree!)[0]!.active).not.toBe("preview:0");
});
it("focus persists leaf selection and snapshots remove stale terminals including tree and last", () => {
  const key = "focus";
  panelTabsStore.setState((s) => ({
    ...s,
    [key]: {
      tabs: ["files", "changes", "terminal:gone"].map((ref) => ({
        ref,
        title: ref,
        openedAt: Date.now(),
      })),
      last: "terminal:gone",
      tree: {
        kind: "leaf",
        id: "root",
        tabs: ["files", "changes", "terminal:gone"],
        active: "files",
      },
    },
  }));
  focusTab(key, "changes");
  expect(dockLeaves(panelTabsStore.state[key]!.tree!)[0]!.active).toBe(
    "changes"
  );
  expect(panelTabsStore.state[key]!.last).toBe("changes");
  focusTab(key, "terminal:gone");
  reconcileTerminals(key, []);
  expect(panelTabsStore.state[key]!.tabs.map((tab) => tab.ref)).toEqual([
    "files",
    "changes",
  ]);
  expect(panelTabsStore.state[key]!.last).toBe("changes");
  expect(dockLeaves(panelTabsStore.state[key]!.tree!)[0]!.active).not.toBe(
    "terminal:gone"
  );
});

it("keeps open state and last selection independent for each session during terminal reconciliation", () => {
  const first = "panel-session-one";
  const second = "panel-session-two";
  openTab(first, { ref: "files", title: "Files" });
  openTab(second, { ref: "changes", title: "Changes" });
  updateTabs(first, (state) => ({ ...state, open: true }));
  updateTabs(second, (state) => ({ ...state, open: false }));
  reconcileTerminals(first, []);
  expect(panelTabsStore.state[first]).toMatchObject({
    open: true,
    last: "files",
  });
  expect(panelTabsStore.state[second]).toMatchObject({
    open: false,
    last: "changes",
  });
});

it("browser navigation updates its saved URL without reopening or selecting a background tab", () => {
  const key = "browser-navigation";
  openTab(key, {
    ref: "browser:a",
    title: "Browser",
    url: "https://start.test/",
  });
  openTab(key, { ref: "files", title: "Files" });
  updateTabs(key, (s) => ({ ...s, open: false }));
  updateTab(key, "browser:a", { url: "https://next.test/" });
  expect(panelTabsStore.state[key]).toMatchObject({
    open: false,
    last: "files",
    tabs: [{ ref: "browser:a", url: "https://next.test/" }, { ref: "files" }],
  });
  const tabs = panelTabsStore.state[key]!.tabs;
  updateTab(key, "browser:a", { url: "https://next.test/" });
  expect(panelTabsStore.state[key]!.tabs).toBe(tabs);
  updateTab(key, "browser:closed", { url: "https://late.test/" });
  expect(panelTabsStore.state[key]!.tabs).toBe(tabs);
});
