import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { PanelWorkspace, moveDockTab } from ".";
const writes = vi.hoisted(() => ({ write: vi.fn(), flush: vi.fn() }));
vi.mock("#renderer/data/db", () => ({ useDb: () => ({}) }));
vi.mock("#renderer/data/db/prefs", () => ({
  usePrefs: () => ({ panes: {}, motion: { reduce: "on" } }),
  createPaneWidthWriter: () => writes,
}));
beforeEach(async () => {
  localStorage.clear();
  await initI18n();
});
const Counter = () => {
  const [value, setValue] = useState(0);
  return <button onClick={() => setValue(value + 1)}>Draft {value}</button>;
};
it("preserves content through expansion, edge splits, collapse and reopening", async () => {
  const apiRef: { current: DockviewApi | null } = { current: null };
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const props = {
    scope: "dummy-session",
    active: "files",
    open: true,
    onSelect,
    onClose,
    apiRef,
    tabs: [
      { id: "chat", title: "Chat", content: () => <Counter /> },
      { id: "files", title: "Files", content: () => <div>File contents</div> },
    ],
  };
  const view = render(<PanelWorkspace {...props} expanded={false} />);
  await waitFor(() => expect(apiRef.current?.panels).toHaveLength(2));
  expect(apiRef.current!.groups[0]!.header.hidden).toBe(true);
  fireEvent.doubleClick(screen.getByRole("separator"));
  expect(writes.write).toHaveBeenCalledWith(400);
  fireEvent.click(screen.getByRole("button", { name: "Draft 0" }));
  view.rerender(<PanelWorkspace {...props} expanded />);
  act(() =>
    apiRef.current!.getPanel("chat")!.api.moveTo({
      group: apiRef.current!.getPanel("files")!.group,
      position: "right",
    })
  );
  await waitFor(() => expect(apiRef.current!.groups).toHaveLength(2));
  expect(apiRef.current!.groups.every((group) => group.header.hidden)).toBe(
    true
  );
  await waitFor(() =>
    expect(
      document.querySelectorAll(
        ".dock-group-island [data-slot=topbar-panel-tabs]"
      )
    ).toHaveLength(0)
  );
  view.rerender(
    <PanelWorkspace
      {...props}
      expanded
      tabs={[
        ...props.tabs,
        {
          id: "terminal:new",
          title: "New terminal",
          content: () => <div>Terminal contents</div>,
        },
      ]}
    />
  );
  await waitFor(() =>
    expect(apiRef.current!.getPanel("terminal:new")?.title).toBe("New terminal")
  );
  view.rerender(<PanelWorkspace {...props} expanded />);
  act(() => moveDockTab(apiRef.current, "chat", "top"));
  await waitFor(() => expect(apiRef.current!.groups).toHaveLength(2));
  expect(apiRef.current!.groups.every((group) => group.header.hidden)).toBe(
    true
  );
  expect(screen.getByRole("button", { name: "Draft 1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close Chat" })).toBeNull();
  view.rerender(<PanelWorkspace {...props} expanded={false} />);
  expect(screen.getByRole("button", { name: "Draft 1" })).toBeTruthy();
  view.rerender(<PanelWorkspace {...props} expanded open={false} />);
  view.rerender(<PanelWorkspace {...props} expanded open />);
  expect(apiRef.current!.groups).toHaveLength(2);
  view.unmount();
});
it("restores split layout for the session on remount, with an unclosable Chat tab", async () => {
  const apiRef: { current: DockviewApi | null } = { current: null };
  const props = {
    scope: "persisted",
    active: "chat",
    open: true,
    expanded: true,
    apiRef,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    tabs: [
      { id: "chat", title: "Chat", content: () => <div>Chat contents</div> },
      { id: "files", title: "Files", content: () => <div>File contents</div> },
    ],
  };
  const first = render(<PanelWorkspace {...props} />);
  await waitFor(() => expect(apiRef.current?.panels).toHaveLength(2));
  act(() =>
    apiRef.current!.getPanel("files")!.api.moveTo({
      group: apiRef.current!.getPanel("chat")!.group,
      position: "bottom",
    })
  );
  await waitFor(() =>
    expect(
      localStorage.getItem("abacusai-bot:dock-layout:v1:persisted")
    ).not.toBeNull()
  );
  first.unmount();
  const restored = JSON.parse(
    localStorage.getItem("abacusai-bot:dock-layout:v1:persisted")!
  );
  delete restored.panels.chat.minimumWidth;
  localStorage.setItem(
    "abacusai-bot:dock-layout:v1:persisted",
    JSON.stringify(restored)
  );
  const second = render(<PanelWorkspace {...props} />);
  await waitFor(() => expect(apiRef.current?.groups).toHaveLength(2));
  expect(screen.queryByRole("button", { name: "Close Chat" })).toBeNull();
  await waitFor(() =>
    expect(apiRef.current!.getPanel("chat")!.minimumWidth).toBe(360)
  );
  expect(apiRef.current!.getPanel("files")!.minimumWidth).toBe(280);
  second.unmount();
});

it("folds a three-column dock below its native minimum and restores every pane", async () => {
  const Original = globalThis.ResizeObserver;
  let resize: (width: number) => void = () => {};
  globalThis.ResizeObserver = class extends Original {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      this.callback = callback;
    }
    callback: ResizeObserverCallback;
    override observe(target: Element, options?: ResizeObserverOptions) {
      super.observe(target, options);
      if ((target as HTMLElement).dataset.slot === "panel-workspace")
        resize = (width) =>
          this.callback(
            [
              {
                target,
                contentRect: { width, height: 800 },
              } as ResizeObserverEntry,
            ],
            this
          );
    }
  };
  const apiRef: { current: DockviewApi | null } = { current: null };
  const view = render(
    <PanelWorkspace
      scope="three-columns"
      expanded
      open
      active="files"
      apiRef={apiRef}
      onSelect={() => {}}
      tabs={[
        { id: "chat", title: "Chat", content: () => <Counter /> },
        { id: "files", title: "Files", content: () => <div>Files</div> },
        {
          id: "terminal",
          title: "Terminal",
          content: () => <div>Terminal</div>,
        },
      ]}
    />
  );
  try {
    await waitFor(() => expect(apiRef.current?.panels).toHaveLength(3));
    act(() => {
      resize(1280);
      moveDockTab(apiRef.current, "chat", "left");
      moveDockTab(apiRef.current, "terminal", "right");
    });
    await waitFor(() => expect(apiRef.current?.groups).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Draft 0" }));
    const layout = localStorage.getItem(
      "abacusai-bot:dock-layout:v1:three-columns"
    );
    act(() => resize(800));
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-expanded]")).toBeNull()
    );
    expect(
      localStorage.getItem("abacusai-bot:dock-layout:v1:three-columns")
    ).toBe(layout);
    act(() => resize(1280));
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-expanded]")).not.toBeNull()
    );
    expect(apiRef.current?.groups).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Draft 1" })).toBeTruthy();
  } finally {
    view.unmount();
    globalThis.ResizeObserver = Original;
  }
});

it("mounts a live chat-only workspace on the first expansion", async () => {
  const apiRef: { current: DockviewApi | null } = { current: null };
  render(
    <PanelWorkspace
      scope="chat-only"
      tabs={[{ id: "chat", title: "Chat", content: () => <Counter /> }]}
      active="chat"
      open
      expanded
      onSelect={() => {}}
      apiRef={apiRef}
    />
  );
  await waitFor(() => expect(apiRef.current?.panels).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Draft 0" })).toBeTruthy();
});
