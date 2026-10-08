import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { expect, it } from "vitest";

import { ABACUS_AGENT_URL } from "./abacus-links";
import { sidebarAccount } from "./sidebar-account";

const account = (tier: string | null, members = 1) =>
  ({
    subscription_tier: tier,
    org_user_count: members,
    plan: "Display plan",
  }) as AbacusAccountInfo;

it.each([
  ["free", false, "upgrade"],
  ["basic", true, "manage"],
  ["go", true, "manage"],
  ["pro", true, "manage"],
  ["max", true, "manage"],
  ["team", true, null],
  ["enterprise", true, null],
  ["business", true, null],
  ["paid", true, null],
  ["trial", false, null],
  ["unknown", false, null],
  [null, false, null],
] as const)(
  "handles %s without guessing billing rights",
  (tier, paid, billing) => {
    expect(sidebarAccount(account(tier))).toMatchObject({
      paid,
      billing,
      plan: "Display plan",
    });
  }
);
it("hides unknown and signed-out accounts, keeps organization billing conservative", () => {
  expect(sidebarAccount(undefined).paid).toBe(false);
  expect(sidebarAccount(null).billing).toBeNull();
  expect(sidebarAccount(account(" Pro ", 4))).toMatchObject({
    paid: true,
    billing: null,
  });
});
it("uses the requested Agent destination", () => {
  expect(ABACUS_AGENT_URL).toBe("https://apps.abacus.ai/chatllm");
});
