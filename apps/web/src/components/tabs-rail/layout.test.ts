import { expect, it } from "vitest";

import { railLayout } from "./layout";
it("fits few tabs, wraps medium sets and scrolls crowded or narrow rails", () => {
  expect(railLayout(2, 600).mode).toBe("single");
  expect(railLayout(6, 600).rows).toBe(1);
  expect(railLayout(12, 720, true)).toMatchObject({ mode: "wrap", rows: 2 });
  expect(railLayout(12, 320, true).mode).toBe("scroll");
  expect(railLayout(30, 1200)).toMatchObject({ mode: "scroll", rows: 1 });
});

it("keeps all counts on one row unless two rows are explicitly enabled", () => {
  for (const width of [320, 480, 720, 1280])
    for (const count of [2, 6, 12, 30]) {
      expect(railLayout(count, width).rows).toBe(1);
      expect(railLayout(count, width, true).rows).toBeLessThanOrEqual(2);
    }
});
