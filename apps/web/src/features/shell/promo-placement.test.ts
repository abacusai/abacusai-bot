import { expect, it } from "vitest";

import { creditExpression } from "./promo-character";
import { promoPlacement } from "./promo-placement";
const defaults = {
  width: 1280,
  height: 900,
  railRight: 56,
  sidebarRight: 56,
  cardHeight: 180,
  obstacles: [],
};
it("uses the character rig expressions for credit states", () => {
  expect(creditExpression(30, 100)).toBe("hopeful");
  expect(creditExpression(5, 100)).toBe("worried");
  expect(creditExpression(0, 100)).toBe("tiredHappy");
});
it.each([1280, 1710])("anchors below a top-pane composer at %ipx", (width) => {
  const result = promoPlacement({
    ...defaults,
    width,
    obstacles: [{ left: 64, right: 1272, top: 310, bottom: 470 }],
  });
  expect(result).toMatchObject({
    left: 72,
    bottom: 24,
    compact: false,
    visibility: "visible",
  });
});
it("moves along the bottom edge to avoid every composer and handle", () => {
  const result = promoPlacement({
    ...defaults,
    width: 1710,
    obstacles: [
      { left: 64, right: 700, top: 700, bottom: 880 },
      { left: 700, right: 708, top: 40, bottom: 900 },
      { left: 1200, right: 1702, top: 700, bottom: 880 },
    ],
  });
  expect(result).toMatchObject({
    left: 724,
    bottom: 24,
    visibility: "visible",
  });
});
it("uses a compact slot before hiding, without moving above unrelated panes", () => {
  const result = promoPlacement({
    ...defaults,
    obstacles: [{ left: 300, right: 1272, top: 700, bottom: 900 }],
  });
  expect(result).toMatchObject({
    left: 72,
    bottom: 24,
    compact: true,
    visibility: "visible",
  });
});
it("hides when even a compact bottom slot would obstruct primary controls", () => {
  expect(
    promoPlacement({
      ...defaults,
      width: 640,
      obstacles: [{ left: 64, right: 632, top: 700, bottom: 900 }],
    })
  ).toMatchObject({ bottom: 24, visibility: "hidden" });
});
it("keeps the Bots strip and its bottom controls clear", () => {
  expect(promoPlacement({ ...defaults, sidebarRight: 144 })).toMatchObject({
    left: 160,
    bottom: 24,
  });
});
