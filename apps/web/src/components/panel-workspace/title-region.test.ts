import { expect, it } from "vitest";

import { titleRegion } from "./title-region";
it.each([800, 1280, 1710])(
  "keeps controls in their own column at %ipx independent of tab count",
  (width) => {
    expect(
      titleRegion({ left: width - 400, right: width - 8 }, 220, width - 8)
    ).toEqual({ left: width - 400, width: 392 });
    expect(
      titleRegion({ left: 56, right: width - 8 }, 220, width - 138)
    ).toEqual({ left: 220, width: width - 358 });
  }
);
it("tracks resizing and protects the caption inset", () => {
  expect(titleRegion({ left: 780, right: 1272 }, 220, 1142)).toEqual({
    left: 780,
    width: 362,
  });
  expect(titleRegion({ left: 880, right: 1272 }, 220, 1142)).toEqual({
    left: 880,
    width: 262,
  });
});
