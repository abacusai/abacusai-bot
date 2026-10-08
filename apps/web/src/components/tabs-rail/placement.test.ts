import { describe, expect, it } from "vitest";

import { tabsRailPlacement } from "./placement";

describe.each(["bots", "sessions"])("%s rail ownership", () => {
  it.each([
    [false, false, false, 500, "none"],
    [true, false, false, 500, "titlebar"],
    [true, false, false, 180, "titlebar"],
    [true, true, false, 500, "titlebar"],
    [true, true, false, 240, "titlebar"],
    [true, true, false, 239, "panel"],
    [true, true, true, 500, "panel"],
    [true, false, true, 500, "titlebar"],
  ] as const)(
    "available=%s floating=%s phone=%s width=%i → %s",
    (available, floating, phone, titleWidth, expected) => {
      const placement = tabsRailPlacement({
        available,
        floating,
        phone,
        titleWidth,
      });
      expect(placement).toBe(expected);
      expect(
        Number(placement === "titlebar") + Number(placement === "panel")
      ).toBe(available ? 1 : 0);
    }
  );
});
