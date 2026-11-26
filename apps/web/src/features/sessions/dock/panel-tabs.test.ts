import { expect, it } from "vitest";

import {
  panelTabsStore,
  openTab,
  closeTab,
  reopenTab,
  updateTabs,
  updateTab,
  focusTab,
  reconcileTerminals,
  openTerminalTab,
  promoteTabs,
  retainTerminalStart,
  forgetWorkspaceTerminals,
} from "./panel-tabs-store";
it("preview eviction repairs last while keeping the most recent 50 previews", () => {
  const key = "eviction";
  panelTabsStore.setState((state) => ({
    ...state,
    [key]: { tabs: [], last: null },
  }));
  for (let i = 0; i < 51; i++)
    openTab(key, { ref: `preview:${i}`, title: `${i}` });
  expect(panelTabsStore.state[key]!.tabs).toHaveLength(50);
  expect(
    panelTabsStore.state[key]!.tabs.some((tab) => tab.ref === "preview:0")
  ).toBe(false);
  expect(panelTabsStore.state[key]!.last).toBe("preview:50");
});
it("focus persists selection and terminal snapshots repair stale references", () => {
  const key = "focus";
  for (const ref of ["files", "changes", "terminal:gone"])
    openTab(key, { ref, title: ref });
  focusTab(key, "changes");
  expect(panelTabsStore.state[key]!.last).toBe("changes");
  focusTab(key, "terminal:gone");
  reconcileTerminals(key, []);
  expect(panelTabsStore.state[key]!.tabs.map((tab) => tab.ref)).toEqual([
    "files",
    "changes",
  ]);
  expect(panelTabsStore.state[key]!.last).toBe("changes");
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

it("reopens closed browser metadata without reviving its closed native resource", () => {
  const key = "reopen-audit";
  openTab(key, {
    ref: "browser:old",
    title: "Example",
    url: "https://example.test",
  });
  closeTab(key, "browser:old");
  const ref = reopenTab(key);
  expect(ref).toMatch(/^browser:/);
  expect(ref).not.toBe("browser:old");
  expect(panelTabsStore.state[key]?.tabs[0]).toMatchObject({
    title: "Example",
    url: "https://example.test",
  });
  expect(reopenTab(key)).toBeNull();
});
it("a new chat's terminal opened while it hands off stays the chat's tab", async () => {
  const draft = "promote-draft";
  const chat = "promote-chat";
  // Opened on the new-chat page while the first turn hands off: its shell is
  // still starting when the chat takes the page's tabs.
  openTerminalTab(draft, { ref: "terminal:late", title: "Terminal" });
  const started = retainTerminalStart(draft, "late");
  promoteTabs(draft, chat);
  expect(panelTabsStore.state[draft]).toBeUndefined();
  reconcileTerminals(chat, []);
  expect(panelTabsStore.state[chat]!.tabs.map((tab) => tab.ref)).toEqual([
    "terminal:late",
  ]);
  // The start settles in the new-chat page's tab: the mark goes from the
  // chat, where the tab now lives, so main's word decides again.
  started();
  await Promise.resolve();
  reconcileTerminals(chat, []);
  expect(panelTabsStore.state[chat]!.tabs).toEqual([]);
});
it("a deleted workspace's chats keep no terminal tabs, shown or not, and other workspaces keep theirs", () => {
  const shown = '["conversation",1,"gone","session","a"]';
  const hidden = '["conversation",1,"gone","session","b"]';
  const other = '["conversation",1,"kept","session","c"]';
  openTab(shown, { ref: "terminal:1", title: "Terminal" });
  openTab(shown, { ref: "files", title: "Files" });
  openTab(hidden, { ref: "terminal:2", title: "Terminal" });
  openTab(other, { ref: "terminal:3", title: "Terminal" });

  expect(forgetWorkspaceTerminals("gone").sort()).toEqual(
    [shown, hidden].sort()
  );
  expect(panelTabsStore.state[shown]!.tabs.map((tab) => tab.ref)).toEqual([
    "files",
  ]);
  expect(panelTabsStore.state[hidden]!.tabs).toEqual([]);
  expect(panelTabsStore.state[other]!.tabs.map((tab) => tab.ref)).toEqual([
    "terminal:3",
  ]);
});
