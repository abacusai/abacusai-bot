import { expect, it } from "vitest";

import { creditMood } from "./promo-character";
import { promoPlacement } from "./promo-placement";

it("uses existing moods for low, nearly exhausted and exhausted credits", () => {
  expect(creditMood(30, 100)).toBe("waiting");
  expect(creditMood(5, 100)).toBe("blocked");
  expect(creditMood(0, 100)).toBe("asleep");
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
    expect(result.left).toBe(232);
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
