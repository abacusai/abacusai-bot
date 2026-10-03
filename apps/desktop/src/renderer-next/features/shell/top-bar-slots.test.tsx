import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { renderWithDb } from "../chat/testing";
import { TopBar } from "./top-bar";
import {
  useTopBarActionList,
  useTopBarActions,
  useTopBarEndActions,
  type TopBarAction,
} from "./top-bar-slots";

const Registration = ({
  actions,
  global = false,
}: {
  actions: TopBarAction[];
  global?: boolean;
}) => {
  // Both hooks are called; only the selected registration has actions.
  useTopBarActions(global ? [] : actions);
  return null;
};
const Global = ({ actions }: { actions: TopBarAction[] }) => {
  useTopBarEndActions(actions);
  return null;
};

it("keeps independent global end registrations through route changes and cleanup", () => {
  const select = vi.fn();
  const route = render(
    <Registration
      actions={[{ id: "route", label: "Route", onSelect: select }]}
    />
  );
  const global = render(
    <Global actions={[{ id: "update", label: "Update", onSelect: select }]} />
  );
  const second = render(
    <Global actions={[{ id: "second", label: "Second", onSelect: select }]} />
  );
  const list = renderHook(() => useTopBarActionList());
  expect(list.result.current.map((a) => a.id)).toEqual([
    "route",
    "update",
    "second",
  ]);
  route.rerender(
    <Registration actions={[{ id: "next", label: "Next", onSelect: select }]} />
  );
  expect(list.result.current.map((a) => a.id)).toEqual([
    "next",
    "update",
    "second",
  ]);
  global.unmount();
  expect(list.result.current.map((a) => a.id)).toEqual(["next", "second"]);
  route.unmount();
  expect(list.result.current.map((a) => a.id)).toEqual(["second"]);
  second.unmount();
  expect(list.result.current).toEqual([]);
  list.unmount();
});

it("renders the global pill expanded and its action in the folded menu", async () => {
  const onSelect = vi.fn();
  const actions = [
    {
      id: "update",
      label: "Install update",
      onSelect,
      render: <button onClick={onSelect}>Update pill</button>,
    },
  ];
  const registration = render(<Global actions={actions} />);
  const expanded = await renderWithDb(<TopBar.Actions folded={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Update pill" }));
  await expanded.cleanup();
  const folded = await renderWithDb(<TopBar.Actions folded />);
  fireEvent.click(screen.getByTestId("topbar-more"));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Install update" })
  );
  expect(onSelect).toHaveBeenCalledTimes(2);
  await folded.cleanup();
  registration.unmount();
});
