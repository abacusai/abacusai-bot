import { expect, it } from "vitest";

import { changeRows } from "./changes-tab";

it("keeps separately staged and unstaged edits without duplicating the aggregate", () => {
  const change = { path: "shared.ts", status: "M" };
  const rows = changeRows({
    gitChangeSections: {
      staged: [change],
      unstaged: [change],
      merged: [change, { path: "new.ts", status: "??" }],
    },
  } as Parameters<typeof changeRows>[0]);
  expect(rows.map(({ change, scope }) => [change.path, scope])).toEqual([
    ["shared.ts", "staged"],
    ["shared.ts", "unstaged"],
    ["new.ts", "unstaged"],
  ]);
});
