import { describe, expect, it } from "vitest";

import { templateColumns } from "./template-columns";

describe("templateColumns", () => {
  it("fills every row when 3 or 4 divides the count", () => {
    expect(templateColumns(6)).toBe(3);
    expect(templateColumns(9)).toBe(3);
    expect(templateColumns(8)).toBe(4);
    expect(templateColumns(12)).toBe(3);
  });

  it("otherwise picks the fuller last row, never a card alone", () => {
    expect(templateColumns(10)).toBe(4); // 4 + 4 + 2, not 3 + 3 + 3 + 1
    expect(templateColumns(5)).toBe(3); // 3 + 2, not 4 + 1
    expect(templateColumns(7)).toBe(4); // 4 + 3
    expect(templateColumns(0)).toBe(3);
  });
});
