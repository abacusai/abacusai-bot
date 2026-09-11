import { describe, expect, it } from "vitest";

import { reportableLivePlatforms } from "./messaging";

describe("what a conversation is told is connected", () => {
  it("counts a shared Abacus bot only beside the user's own account on that app", () => {
    expect(reportableLivePlatforms(["abacus_telegram", "discord"])).toEqual([
      "discord",
    ]);
    expect(
      reportableLivePlatforms(["telegram", "abacus_telegram", "whatsapp"])
    ).toEqual(["telegram", "abacus_telegram", "whatsapp"]);
    expect(
      reportableLivePlatforms(["abacus_discord", "abacus_telegram"])
    ).toEqual([]);
  });
});
