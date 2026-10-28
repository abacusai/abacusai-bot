import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resetFreeCreditsWatch } from "#renderer/lib/free-credits-watch";
import { initI18n } from "#renderer/lib/i18n";
import { onPlanActive } from "#renderer/lib/upgrade";
import { upgradeDialogStore } from "#renderer/lib/upgrade-dialog";

import { UpgradePromo } from "./credits-card";
import { PromoOutlet } from "./promo-host";
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
    free_credits_held: undefined as boolean | undefined,
  },
  billing: null as BillingPlan | null,
  exhaustedAt: null as number | null,
  refetch: vi.fn(),
  refetchQueries: vi.fn(async () => {}),
  query: vi.fn(),
  open: vi.fn(),
  update: vi.fn(),
  readAccount: vi.fn(),
  listModels: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ refetchQueries: state.refetchQueries }),
  useQuery: (options: { queryKey?: unknown }) => {
    state.query(options);
    if ((options.queryKey as unknown[])[0] === "billingPlan")
      return state.billing == null
        ? { data: undefined, status: "pending" }
        : { data: state.billing, status: "success" };
    return {
      data: state.account,
      dataUpdatedAt: Date.now(),
      refetch: state.refetch,
    };
  },
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
            key: () => ["account"],
          },
          billingPlan: {
            queryOptions: () => ({ queryKey: ["billingPlan"] }),
          },
        },
      },
      client: {
        system: { openExternal: state.open },
        account: {
          abacus: state.readAccount,
          upgradeUrl: async () => "https://checkout.example/once",
        },
        models: { list: state.listModels },
      },
    },
  }),
}));
vi.mock("#renderer/lib/platform-system", async (original) => ({
  ...(await original<typeof import("#renderer/lib/platform-system")>()),
  openPendingLink: async (_client: unknown, resolve: () => Promise<string>) => {
    state.open({ url: await resolve() });
  },
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
// The card lives in the sidebar: render it with a pinned sidebar's outlet.
const promo = () => (
  <>
    <UpgradePromo />
    <PromoOutlet floating={false} />
  </>
);
const BILLING: BillingPlan = {
  current: {
    planName: "Free",
    creditsRemaining: 5,
    creditsGranted: 100,
    freeTierExpiresAt: null,
  },
  plans: [],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "$10/mo",
      features: [],
      url: null,
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};
/** The sidebar's pitch: the plan's own order, whichever side the account uses. */
const PITCH_IN_PLAN_ORDER = [
  "Image and video generation",
  expect.stringMatching(/^Personal agents/),
  expect.stringMatching(/^100\+ connectors/),
  "Build and deploy powerful apps on the web, including mobile apps",
];

beforeEach(async () => {
  await initI18n();
  localStorage.clear();
  state.billing = BILLING;
  state.exhaustedAt = null;
  state.query.mockClear();
  state.refetch.mockClear();
  state.refetch.mockResolvedValue({ data: state.account, isError: false });
  state.update.mockResolvedValue(undefined);
  state.account.subscription_tier = "free";
  state.account.user_id = "dummy";
  state.account.credits_used = 95;
  state.account.free_credits_held = undefined;
});
it("shows actual credit progress and reacts to CTA focus", () => {
  render(promo());
  expect(screen.getByText("5 of 100 credits left")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "95"
  );
  fireEvent.focus(screen.getByRole("button", { name: "Upgrade" }));
  expect(screen.getByTestId("character").textContent).toBe("excited");
  expect(
    screen.queryByRole("button", { name: "Remind me in 10 minutes" })
  ).toBeNull();
});
it("lists the plan's whole pitch once the plan is read, never half a card", () => {
  state.billing = null;
  const view = render(promo());
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  state.billing = BILLING;
  view.rerender(promo());
  expect(screen.getByText("Everything Basic gives you")).toBeTruthy();
  expect(
    [...document.querySelectorAll('[data-slot="upgrade-pitch"] li')].map(
      (line) => line.textContent
    )
  ).toEqual(PITCH_IN_PLAN_ORDER);
});

it("lists the pitch in the same order for a bots account as for a sessions one", () => {
  const accountFocus = (state.account as { focus?: string }).focus;
  try {
    for (const focus of ["sessions", "bots", "mixed"]) {
      (state.account as { focus?: string }).focus = focus;
      const view = render(promo());
      expect(
        [...document.querySelectorAll('[data-slot="upgrade-pitch"] li')].map(
          (line) => line.textContent
        )
      ).toEqual(PITCH_IN_PLAN_ORDER);
      view.unmount();
    }
  } finally {
    (state.account as { focus?: string }).focus = accountFocus;
  }
});

it("points an account already on a paid tier at AbacusAI Agent on the web", async () => {
  state.account.subscription_tier = "pro";
  state.open.mockClear();
  render(promo());
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull()
  );
  expect(screen.getByText("Do even more on AbacusAI Agent")).toBeTruthy();
  expect(screen.getByText("5 of 100 credits left")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Go to AbacusAI Agent on the web" })
  );
  expect(state.open).toHaveBeenCalledWith({
    url: "https://apps.abacus.ai/chatllm",
  });
});

it("held free credits: locked, not the grant, and Verify opens the page and reads the account on return", () => {
  state.account.free_credits_held = true;
  state.account.credits_granted = 2000;
  state.account.credits_used = 0;
  state.open.mockClear();
  state.refetchQueries.mockClear();
  try {
    render(promo());
    expect(screen.getByText("Credits locked — verify your phone")).toBeTruthy();
    expect(screen.queryByText(/credits left/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));
    expect(state.open).toHaveBeenCalledWith({
      url: "https://apps.abacus.ai/bot/link/verify-phone",
    });
    window.dispatchEvent(new Event("focus"));
    expect(state.refetchQueries).toHaveBeenCalledWith(
      { queryKey: ["account"] },
      { cancelRefetch: false }
    );
  } finally {
    state.account.credits_granted = 100;
    resetFreeCreditsWatch();
  }
});

it("unlocked, or a server that does not say: the usual card with the balance", () => {
  for (const held of [false, undefined]) {
    state.account.free_credits_held = held;
    const view = render(promo());
    expect(screen.getByText("5 of 100 credits left")).toBeTruthy();
    expect(screen.queryByText("Credits locked — verify your phone")).toBeNull();
    view.unmount();
  }
});

it("rounds floating point credit balances without changing progress", () => {
  state.account.credits_used = 95.36000000000001;
  render(promo());
  expect(screen.getByText("4.64 of 100 credits left")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "95.36000000000001"
  );
});

it("swaps the promo for the web card immediately on upgrade and restores it on downgrade", () => {
  const view = render(promo());
  state.account = { ...state.account, subscription_tier: "pro" };
  view.rerender(promo());
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Go to AbacusAI Agent on the web" })
  ).toBeTruthy();
  state.account = { ...state.account, subscription_tier: "free" };
  view.rerender(promo());
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});

it("hands one mounted mascot between pinned and peek sidebars, and hides it when collapsed", () => {
  const App = ({ mode }: { mode: "pinned" | "peek" | "collapsed" }) => (
    <>
      <UpgradePromo />
      {mode !== "collapsed" && <PromoOutlet floating={mode === "peek"} />}
    </>
  );
  const view = render(<App mode="pinned" />);
  const mascot = screen.getByTestId("character");
  fireEvent.focus(screen.getByRole("button", { name: "Upgrade" }));
  openFloating("peek");
  view.rerender(<App mode="peek" />);
  expect(screen.getByTestId("character")).toBe(mascot);
  expect(mascot.textContent).toBe("excited");
  closeFloating();
  view.rerender(<App mode="collapsed" />);
  expect(document.querySelector('[data-slot="upgrade-promo"]')).toBeNull();
  view.rerender(<App mode="pinned" />);
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});

it("keeps one account cache when an exhaustion notice is cleared", () => {
  const view = render(promo());
  state.exhaustedAt = Date.now();
  view.rerender(promo());
  expect(state.refetch).toHaveBeenCalledOnce();
  state.exhaustedAt = null;
  view.rerender(promo());
  for (const [options] of state.query.mock.calls)
    if (options.queryKey[0] !== "billingPlan")
      expect(options.queryKey).toEqual(["account"]);
});

afterEach(() => {
  vi.useRealTimers();
});

it("after Upgrade, reads the account until the plan is active, then tells the app at once and stops", async () => {
  vi.useFakeTimers();
  state.open.mockClear();
  const paid = { ...state.account, subscription_tier: "basic" };
  state.readAccount.mockReset();
  state.readAccount
    .mockResolvedValueOnce(state.account)
    .mockResolvedValueOnce(paid);
  state.listModels.mockReset().mockResolvedValue([]);
  const heard = vi.fn();
  const stop = onPlanActive(heard);
  try {
    render(promo());
    // The card already shows the plan's whole pitch: its Upgrade opens the
    // payment page itself, with no dialog in between.
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(upgradeDialogStore.state.request).toBeNull();
    // A second click while checkout is open watches nothing twice.
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(upgradeDialogStore.state.request).toBeNull();
    expect(state.open).toHaveBeenCalledWith({
      url: "https://checkout.example/once",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.readAccount).toHaveBeenCalledTimes(1);
    expect(heard).not.toHaveBeenCalled();

    // Back from the browser: read at once, not on the next tick.
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.readAccount).toHaveBeenCalledTimes(2);
    expect(state.readAccount).toHaveBeenLastCalledWith({ refresh: true });
    expect(state.listModels).toHaveBeenCalledWith({ refresh: true });
    expect(heard).toHaveBeenCalledWith(paid);

    // Paid: the watch is over.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.readAccount).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it("stops watching when the checkout link has run out, the plan unchanged", async () => {
  vi.useFakeTimers();
  state.readAccount.mockReset().mockResolvedValue(state.account);
  const heard = vi.fn();
  const stop = onPlanActive(heard);
  try {
    render(promo());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const reads = state.readAccount.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.readAccount).toHaveBeenCalledTimes(reads);
    expect(heard).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});
