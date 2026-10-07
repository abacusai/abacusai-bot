import { expect, it } from "vitest";

import { creditExpression } from "./promo-character";
import { promoPlacement } from "./promo-placement";

it("uses the character rig expressions for low, nearly exhausted and exhausted credits", () => {
  expect(creditExpression(30, 100)).toBe("hopeful");
  expect(creditExpression(5, 100)).toBe("worried");
  expect(creditExpression(0, 100)).toBe("tiredHappy");
});
it.each([1280, 1710])(
  "keeps the corner card clear of composer and sidebar footer at %ipx",
  (width) => {
    const composer = { left: 280, right: 900, top: 700, bottom: 880 };
    const footer = { left: 56, right: 296, top: 850, bottom: 900 };
    const result = promoPlacement({
      width,
      height: 900,
      railRight: 56,
      sidebarRight: 296,
      paneTop: 40,
      cardHeight: 180,
      composer,
      footer,
      splitters: [],
    });
    expect(result.left).toBe(312);
    expect(result.visibility).toBe("visible");
    expect(900 - result.bottom).toBeLessThan(composer.top);
    expect(900 - result.bottom).toBeLessThan(footer.top);
  }
);
it("keeps splitters clear and hides when the available island is too small", () => {
  const result = promoPlacement({
    width: 800,
    height: 300,
    railRight: 56,
    sidebarRight: 56,
    paneTop: 40,
    cardHeight: 180,
    composer: { left: 56, right: 800, top: 180, bottom: 300 },
    splitters: [{ left: 300, right: 308, top: 40, bottom: 300 }],
  });
  expect(result.left).toBe(320);
  expect(result.visibility).toBe("hidden");
});
it("leaves the floating card at the bottom when a centered composer is above it", () => {
  expect(
    promoPlacement({
      width: 1280,
      height: 900,
      railRight: 56,
      sidebarRight: 56,
      paneTop: 40,
      cardHeight: 180,
      composer: { left: 200, right: 1100, top: 350, bottom: 500 },
      splitters: [],
    }).bottom
  ).toBe(24);
});

it("keeps a collapsed Bots strip clear", () => {
  const result = promoPlacement({
    width: 820,
    height: 900,
    railRight: 56,
    sidebarRight: 144,
    paneTop: 40,
    cardHeight: 180,
    splitters: [],
  });
  expect(result.left).toBe(160);
});
