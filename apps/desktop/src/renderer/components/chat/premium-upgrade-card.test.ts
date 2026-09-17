import { describe, expect, it } from "vitest";

import { freeModelSwitches, wantsUpgradeCard } from "./premium-upgrade-card";

describe("the upgrade card's free-model switches", () => {
  it("offers each named switch-model action, labelled", () => {
    expect(
      freeModelSwitches([
        { type: "upgrade-abacus", link: "https://example.invalid/plan" },
        {
          type: "switch-model",
          model: "abacus/stealth/union-alpha",
          label: "Union Alpha",
        },
      ])
    ).toEqual([{ model: "abacus/stealth/union-alpha", label: "Union Alpha" }]);
  });

  it("ignores the bare switch action, which only opens the picker", () => {
    expect(freeModelSwitches([{ type: "switch-model" }])).toEqual([]);
    expect(freeModelSwitches(undefined)).toEqual([]);
  });

  it("still wants the card when switches ride along", () => {
    expect(
      wantsUpgradeCard([
        { type: "upgrade-abacus" },
        { type: "switch-model", model: "abacus/x" },
      ])
    ).toBe(true);
  });
});
