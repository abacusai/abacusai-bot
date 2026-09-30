import { expect, it } from "vitest";

import {
  dockReducer,
  dockLeaves,
  dockMinimum,
  foldedDock,
  type DockNode,
} from "./dock-store";
import { sessionLayout, clampChatWidth } from "./layout";
it("R4-T21 enforces the bounded tree and leaves Chat fixed", () => {
  const leaf: DockNode = {
    kind: "leaf",
    id: "one",
    tabs: ["files", "changes", "browser:b", "device"],
    active: "files",
  };
  const columns = dockReducer(leaf, {
    type: "move",
    tab: "files",
    target: "one",
    edge: "right",
    id: "two",
  });
  expect(dockLeaves(columns)).toHaveLength(2);
  expect(dockMinimum(columns, "width")).toBe(488);
  const rows = dockReducer(columns, {
    type: "move",
    tab: "changes",
    target: "one",
    edge: "bottom",
    id: "three",
  });
  expect(dockLeaves(rows)).toHaveLength(3);
  expect(dockMinimum(rows, "height")).toBe(488);
  expect(
    dockReducer(rows, {
      type: "move",
      tab: "device",
      target: "one",
      edge: "bottom",
      id: "four",
    })
  ).toBe(rows);
  expect(
    dockReducer(rows, { type: "move", tab: "chat", target: "two", id: "chat" })
  ).toBe(rows);
  expect(dockLeaves(foldedDock(rows, 400, 600, "files"))).toHaveLength(1);
  expect(foldedDock(rows, 600, 600, "files")).toBe(rows);
});
it("R4-T15 folds at 1100 only for a split, keeps chat distinct from closed", () => {
  expect(sessionLayout(1100, "split", "changes", true)).toMatchObject({
    split: true,
    sidebar: "floating",
    closed: false,
  });
  expect(sessionLayout(1099, "split", "chat", true)).toMatchObject({
    split: false,
    chatFirst: true,
    closed: false,
  });
  expect(sessionLayout(900, "full", undefined, true)).toMatchObject({
    closed: true,
    chatFirst: false,
  });
  expect(clampChatWidth(480, 800, 488)).toBe(360);
});
it("reorders within a leaf without duplicating tabs and accepts all edge directions", () => {
  const leaf: DockNode = {
    kind: "leaf",
    id: "root",
    tabs: ["files", "changes", "browser:b"],
    active: "files",
  };
  const reordered = dockReducer(leaf, {
    type: "move",
    tab: "browser:b",
    target: "root",
    before: "files",
    id: "unused",
  });
  expect(dockLeaves(reordered)[0]!.tabs).toEqual([
    "browser:b",
    "files",
    "changes",
  ]);
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    const split = dockReducer(leaf, {
      type: "move",
      tab: "files",
      target: "root",
      edge,
      id: "new",
    });
    expect(
      dockLeaves(split)
        .flatMap((l) => l.tabs)
        .sort()
    ).toEqual([...leaf.tabs].sort());
    expect(dockLeaves(split)).toHaveLength(2);
  }
});
