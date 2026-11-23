import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import { initI18n } from "#renderer/lib/i18n";
import { TooltipProvider } from "#renderer/ui/tooltip";

import { dropOrder, mergeOrder, TabsRail } from ".";
vi.mock("#renderer/data/db/prefs", () => ({
  usePrefs: () => ({ ...fixturePrefs(), motion: { reduce: "on" } }),
}));
it("selects by shortcut, protects Chat, reopens and renames terminals", async () => {
  await initI18n();
  const change = vi.fn(),
    close = vi.fn(),
    reopen = vi.fn(),
    rename = vi.fn();
  render(
    <header data-slot="topbar">
      <TabsRail
        tabs={[
          { id: "chat", kind: "thread", title: "Chat" },
          { id: "terminal:one", kind: "terminal", title: "Terminal" },
        ]}
        active="chat"
        title={(tab) => tab.title!}
        kinds={[]}
        onChange={change}
        onClose={close}
        onReorder={() => {}}
        onAdd={() => {}}
        onReopen={reopen}
        onRename={rename}
      />
    </header>
  );
  fireEvent.keyDown(window, { key: "2", ctrlKey: true });
  expect(change).toHaveBeenCalledWith("terminal:one");
  fireEvent.keyDown(window, { key: "w", ctrlKey: true });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
  expect(reopen).toHaveBeenCalledOnce();
  fireEvent.doubleClick(screen.getByRole("tab", { name: "Terminal" }));
  const input = await screen.findByRole("textbox", { name: "Rename tab" });
  fireEvent.change(input, { target: { value: "Build" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(rename).toHaveBeenCalledWith("terminal:one", "Build")
  );
});

it("keeps the full title discoverable on keyboard focus with reduced motion", async () => {
  await initI18n();
  const label = "src/features/sessions/workspace/a-very-long-filename.test.ts";
  render(
    <TooltipProvider>
      <TabsRail
        tabs={[{ id: "files:long", kind: "files", title: label }]}
        active="files:long"
        title={(tab) => tab.title!}
        kinds={[]}
        onChange={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
        onAdd={() => {}}
      />
    </TooltipProvider>
  );
  fireEvent.keyDown(document, { key: "Tab" });
  act(() => screen.getByRole("tab", { name: label }).focus());
  expect(
    (await screen.findByRole("tooltip", { hidden: true })).textContent
  ).toContain(label);
  expect(document.querySelector("[data-marquee-active]")).toBeNull();
});

it("drops a tab before or after the one it lands on, keeping Chat first", () => {
  const ids = ["chat", "files", "changes", "agents"];
  expect(dropOrder(ids, "files", "agents", true)).toEqual([
    "chat",
    "changes",
    "agents",
    "files",
  ]);
  expect(dropOrder(ids, "files", "agents", false)).toEqual([
    "chat",
    "changes",
    "files",
    "agents",
  ]);
  expect(dropOrder(ids, "agents", "chat", false)).toEqual([
    "chat",
    "agents",
    "files",
    "changes",
  ]);
});

it("does not snap the strip, so a dragged tab moves alone", async () => {
  await initI18n();
  render(
    <TabsRail
      tabs={[
        { id: "files", kind: "files", title: "Files" },
        { id: "changes", kind: "changes", title: "Changes" },
      ]}
      active="files"
      title={(tab) => tab.title!}
      kinds={[]}
      onChange={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
      onAdd={() => {}}
    />
  );
  const strip = document.querySelector<HTMLElement>("[data-topbar-tabs]")!;
  for (const element of [strip, ...strip.children])
    expect(element.className).not.toMatch(/\bsnap-/);
});

it("native drag keeps a dimmed placeholder, draws an unclipped preview and marks the drop edge", async () => {
  await initI18n();
  render(
    <TabsRail
      tabs={[
        { id: "files", kind: "files", title: "Files" },
        { id: "changes", kind: "changes", title: "Changes" },
      ]}
      active="files"
      title={(tab) => tab.title!}
      kinds={[]}
      onChange={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
      onAdd={() => {}}
      onDragStart={(id, event) =>
        event.dataTransfer.setData("application/x-abacus-panel", id)
      }
    />
  );
  const items = [...document.querySelectorAll<HTMLElement>("[draggable]")];
  const setDragImage = vi.fn();
  const dataTransfer = {
    setData: vi.fn(),
    setDragImage,
    types: ["application/x-abacus-panel"],
  };
  fireEvent.dragStart(items[0]!, { dataTransfer });
  expect(items[0]!.hasAttribute("data-dragging")).toBe(true);
  const ghost = setDragImage.mock.calls[0]![0] as HTMLElement;
  expect(ghost.parentElement).toBe(document.body);
  // The browser fires `drag` on the source all through a native drag.
  fireEvent.drag(items[0]!, { dataTransfer });
  fireEvent.dragOver(items[1]!, { dataTransfer });
  expect(items[1]!.getAttribute("data-drop")).toMatch(/^(before|after)$/);
  fireEvent.dragEnd(items[0]!, { dataTransfer });
  expect(items[0]!.hasAttribute("data-dragging")).toBe(false);
  expect(items[1]!.hasAttribute("data-drop")).toBe(false);
});

it("puts each pane's tabs over that pane, with one shared set of menus and shortcuts", async () => {
  await initI18n();
  const change = vi.fn();
  render(
    <header data-slot="topbar">
      <TooltipProvider>
        <TabsRail
          columns={[
            { ids: ["terminal:a"], active: "terminal:a", left: 0, right: 500 },
            { ids: ["chat", "files"], active: "chat", left: 508, right: 1000 },
          ]}
          tabs={[
            { id: "chat", kind: "thread", title: "Chat" },
            { id: "files", kind: "files", title: "Files" },
            { id: "terminal:a", kind: "terminal", title: "Terminal" },
          ]}
          active="chat"
          title={(tab) => tab.title!}
          kinds={["terminal", "files"]}
          onChange={change}
          onClose={() => {}}
          onReorder={() => {}}
          onAdd={() => {}}
          onMove={() => {}}
        />
      </TooltipProvider>
    </header>
  );
  const lists = screen.getAllByRole("tablist");
  expect(lists).toHaveLength(2);
  expect(lists[0]!.textContent).toContain("Terminal");
  expect(lists[1]!.textContent).toContain("Chat");
  expect(lists[1]!.textContent).toContain("Files");
  expect(screen.getAllByTestId("panel-add-tab")).toHaveLength(1);
  // ⌘N counts across every pane, in rail order, and is handled once.
  fireEvent.keyDown(window, { key: "3", ctrlKey: true });
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith("terminal:a");
});

it("merges one pane's new order back into the full tab order", () => {
  expect(mergeOrder(["chat", "a", "files", "b"], ["b", "a"]).join()).toBe(
    "chat,b,files,a"
  );
});

it("keeps the grouped strips flush and the title bar draggable between tabs", async () => {
  await initI18n();
  const columns = [
    { ids: ["chat"], active: "chat", left: 0, right: 300 },
    { ids: ["terminal:one"], active: "terminal:one", left: 308, right: 600 },
  ];
  const { container } = render(
    <header data-slot="topbar">
      <TabsRail
        columns={columns}
        tabs={[
          { id: "chat", kind: "thread", title: "Chat" },
          { id: "terminal:one", kind: "terminal", title: "Terminal" },
        ]}
        active="chat"
        title={(tab) => tab.title!}
        kinds={[]}
        onChange={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
        onAdd={() => {}}
      />
    </header>
  );
  const groups = container.querySelector(
    '[data-slot="topbar-panel-tabs-groups"]'
  )!;
  expect(groups.className).toContain("titlebar-drag");
  expect(groups.className).toContain("gap-0");
  const strips = [
    ...container.querySelectorAll('[data-slot="topbar-panel-tabs"]'),
  ];
  expect(strips).toHaveLength(2);
  for (const strip of strips) {
    expect(strip.className).toContain("titlebar-drag");
    expect(strip.className).not.toContain("pl-2");
    expect(strip.className).not.toContain("titlebar-nodrag");
  }
  for (const tab of screen.getAllByRole("tab"))
    expect(tab.className).toContain("titlebar-nodrag");
});
