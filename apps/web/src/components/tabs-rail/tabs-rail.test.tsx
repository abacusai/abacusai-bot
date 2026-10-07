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

import { TabsRail } from ".";
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
