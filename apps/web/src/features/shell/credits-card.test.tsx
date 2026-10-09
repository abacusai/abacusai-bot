import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { UpgradePromo } from "./credits-card";
import { PromoOutlet } from "./promo-host";
import { promoAccountKey } from "./promo-state";
import { openFloating, closeFloating } from "./shell-store";

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
  exhaustedAt: null as number | null,
  refetch: vi.fn(),
  query: vi.fn(),
  open: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown }) => {
    state.query(options);
    return {
      data: state.account,
      dataUpdatedAt: Date.now(),
      refetch: state.refetch,
    };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ href: "/sessions/example" }),
}));
vi.mock("#renderer/data/db/prefs", () => ({
  usePrefs: () => ({ creditsExhaustedAt: state.exhaustedAt }),
  useUpdatePrefs: () => state.update,
}));
vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => ({
    transport: {
      orpc: {
        account: {
          abacus: {
            queryOptions: () => ({ queryKey: ["account"] }),
            queryKey: () => ["account"],
          },
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
  state.exhaustedAt = null;
  state.query.mockClear();
  state.refetch.mockClear();
  state.refetch.mockResolvedValue({ data: state.account, isError: false });
  state.update.mockResolvedValue(undefined);
  state.account.subscription_tier = "free";
  state.account.user_id = "dummy";
  state.account.credits_used = 95;
});
it("shows actual credit progress, reacts to CTA focus and persists snooze across remount", () => {
  const first = render(<UpgradePromo />);
  expect(screen.getByText("5 of 100 credits left")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "95"
  );
  fireEvent.focus(screen.getByRole("button", { name: "Upgrade" }));
  expect(screen.getByTestId("character").textContent).toBe("excited");
  fireEvent.click(
    screen.getByRole("button", { name: "Remind me in 10 minutes" })
  );
  expect(localStorage.getItem(promoAccountKey(state.account))).not.toBeNull();
  first.unmount();
  const second = render(<UpgradePromo />);
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  second.unmount();
});
it("does not show the promo for an account already on a paid tier", async () => {
  state.account.subscription_tier = "pro";
  render(<UpgradePromo />);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull()
  );
});

it("rounds floating point credit balances without changing progress", () => {
  state.account.credits_used = 95.36000000000001;
  render(<UpgradePromo />);
  expect(screen.getByText("4.64 of 100 credits left")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "95.36000000000001"
  );
});

it("removes the promo immediately on upgrade and restores it on downgrade", () => {
  const view = render(<UpgradePromo />);
  state.account = { ...state.account, subscription_tier: "pro" };
  view.rerender(<UpgradePromo />);
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  expect(screen.queryByTestId("character")).toBeNull();
  state.account = { ...state.account, subscription_tier: "free" };
  view.rerender(<UpgradePromo />);
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});

afterEach(() => vi.useRealTimers());
it("expires a persisted snooze after ten minutes while mounted", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  const first = render(<UpgradePromo />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remind me in 10 minutes" })
  );
  first.unmount();
  render(<UpgradePromo />);
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
  });
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});
it("refreshes snooze on window focus and isolates accounts", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  const first = render(<UpgradePromo />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remind me in 10 minutes" })
  );
  first.unmount();
  const second = render(<UpgradePromo />);
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  vi.setSystemTime(new Date("2030-01-01T00:10:01Z"));
  fireEvent(window, new Event("focus"));
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
  second.unmount();
  state.account.user_id = "another-dummy";
  render(<UpgradePromo />);
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});
it("reappears immediately when a snoozed free account exhausts its credits", () => {
  const first = render(<UpgradePromo />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remind me in 10 minutes" })
  );
  first.unmount();
  state.account.credits_used = 100;
  render(<UpgradePromo />);
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});

it("does not apply one account's active snooze to another account", () => {
  const first = render(<UpgradePromo />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remind me in 10 minutes" })
  );
  first.unmount();
  state.account.user_id = "another-dummy";
  const second = render(<UpgradePromo />);
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
  second.unmount();
  state.account.user_id = "dummy";
  render(<UpgradePromo />);
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
});

it("hands one mounted mascot between pinned, peek and collapsed presentations", async () => {
  const App = ({ mode }: { mode: "pinned" | "peek" | "collapsed" }) => (
    <>
      <UpgradePromo />
      {mode !== "collapsed" && <PromoOutlet floating={mode === "peek"} />}
    </>
  );
  const view = render(<App mode="pinned" />);
  const mascot = screen.getByTestId("character");
  const card = mascot.closest('[data-slot="upgrade-promo"]')!;
  expect(card.getAttribute("data-presentation")).toBe("sidebar");
  fireEvent.focus(screen.getByRole("button", { name: "Upgrade" }));
  openFloating("peek");
  view.rerender(<App mode="peek" />);
  expect(screen.getByTestId("character")).toBe(mascot);
  expect(mascot.textContent).toBe("excited");
  closeFloating();
  view.rerender(<App mode="collapsed" />);
  expect(screen.getByTestId("character")).toBe(mascot);
  expect(card.getAttribute("data-presentation")).toBe("floating");
  expect(document.querySelectorAll('[data-slot="upgrade-promo"]')).toHaveLength(
    1
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remind me in 10 minutes" })
  );
  view.rerender(<App mode="pinned" />);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull()
  );
});

it("keeps one account cache when an exhaustion notice is cleared", () => {
  const view = render(<UpgradePromo />);
  state.exhaustedAt = Date.now();
  view.rerender(<UpgradePromo />);
  expect(state.refetch).toHaveBeenCalledOnce();
  state.exhaustedAt = null;
  view.rerender(<UpgradePromo />);
  for (const [options] of state.query.mock.calls)
    expect(options.queryKey).toEqual(["account"]);
});
