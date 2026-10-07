import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { UpgradePromo } from "./credits-card";
import { promoAccountKey } from "./promo-state";

const state = vi.hoisted(() => ({
  account: {
    user_id: "dummy",
    organization_id: "dummy-org",
    name: null,
    email: null,
    picture: null,
    organization: null,
    org_user_count: null,
    plan: null,
    subscription_tier: "free",
    credits_granted: 100,
    credits_used: 95,
  },
  open: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.account, dataUpdatedAt: 1 }),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ href: "/sessions/example" }),
}));
vi.mock("#renderer/data/db/prefs", () => ({
  usePrefs: () => ({ creditsExhaustedAt: null }),
  useUpdatePrefs: () => state.update,
}));
vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => ({
    transport: {
      orpc: {
        account: {
          abacus: { queryOptions: () => ({}), queryKey: () => ["account"] },
        },
      },
      client: { system: { openExternal: state.open } },
    },
  }),
}));
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "reduced",
}));
vi.mock("./promo-character", () => ({
  PromoCharacter: ({ excited }: { excited: boolean }) => (
    <span data-testid="character">{excited ? "excited" : "worried"}</span>
  ),
}));
beforeEach(async () => {
  await initI18n();
  localStorage.clear();
  state.account.subscription_tier = "free";
});
it("shows actual credit progress, reacts to CTA focus and persists dismissal across remount", () => {
  const first = render(<UpgradePromo />);
  expect(screen.getByText("5 of 100 credits left")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "95"
  );
  fireEvent.focus(screen.getByRole("button", { name: "Upgrade" }));
  expect(screen.getByTestId("character").textContent).toBe("excited");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(localStorage.getItem(promoAccountKey(state.account))).not.toBeNull();
  first.unmount();
  const second = render(<UpgradePromo />);
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  second.unmount();
});
it("does not show the promo for an account already on a paid tier", () => {
  state.account.subscription_tier = "pro";
  render(<UpgradePromo />);
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
});

it("celebrates only a confirmed free-to-paid account change", () => {
  const view = render(<UpgradePromo />);
  state.account.subscription_tier = "pro";
  view.rerender(<UpgradePromo />);
  expect(screen.getByText("Level unlocked. Let’s build!")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Upgrade" }).hasAttribute("disabled")
  ).toBe(true);
});
