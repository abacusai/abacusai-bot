import { describe, expect, it } from "vitest";

import { isImeComposing } from "./ime";

const keydown = (init: KeyboardEventInit) => ({
  nativeEvent: new KeyboardEvent("keydown", init),
});

describe("isImeComposing", () => {
  it("is true for the Enter that confirms a conversion", () => {
    expect(isImeComposing(keydown({ key: "Enter", isComposing: true }))).toBe(
      true
    );
  });

  it("is false for a plain Enter", () => {
    expect(isImeComposing(keydown({ key: "Enter" }))).toBe(false);
  });
});
