import { expect, it } from "vitest";

import { groupInsets } from "./group-insets";
const workspace = { left: 0, top: 0, right: 1200, bottom: 800 };
it("adds no padding to a single group's outer edges", () => {
  expect(Object.values(groupInsets(workspace, workspace))).toEqual([
    false,
    false,
    false,
    false,
  ]);
});
it.each([
  [{ left: 0, top: 0, right: 600, bottom: 800 }, [false, true, false, false]],
  [
    { left: 600, top: 0, right: 1200, bottom: 800 },
    [false, false, false, true],
  ],
  [{ left: 0, top: 0, right: 1200, bottom: 400 }, [false, false, true, false]],
  [
    { left: 0, top: 400, right: 1200, bottom: 800 },
    [true, false, false, false],
  ],
  [
    { left: 600, top: 400, right: 1200, bottom: 800 },
    [true, false, false, true],
  ],
])(
  "keeps only internal half gutters in split and nested layouts",
  (group, expected) => {
    expect(Object.values(groupInsets(group, workspace))).toEqual(expected);
  }
);
