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
