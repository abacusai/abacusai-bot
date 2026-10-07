import { expect, it } from "vitest";

import { railLayout } from "./layout";
it("fits few tabs, wraps medium sets and scrolls crowded or narrow rails", () => {
  expect(railLayout(2, 600).mode).toBe("single");
  expect(railLayout(6, 600).rows).toBe(1);
  expect(railLayout(12, 720)).toMatchObject({ mode: "wrap", rows: 2 });
  expect(railLayout(12, 320).mode).toBe("scroll");
  expect(railLayout(30, 1200)).toMatchObject({ mode: "scroll", rows: 1 });
});
