import { describe, expect, it } from "vitest";

import { isRouteTransitionActive } from "./route-transition";

describe("isRouteTransitionActive", () => {
  it("is false without the API (jsdom) and while nothing is in flight", () => {
    expect(isRouteTransitionActive(document)).toBe(false);
    expect(
      isRouteTransitionActive({ activeViewTransition: null } as never)
    ).toBe(false);
  });
  it("is true while the document has an active view transition", () => {
    expect(isRouteTransitionActive({ activeViewTransition: {} } as never)).toBe(
      true
    );
  });
});
