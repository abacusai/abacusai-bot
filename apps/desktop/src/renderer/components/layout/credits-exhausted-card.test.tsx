/**
 * The sidebar's out-of-credits card: shown to the free plan once a turn has
 * died for want of credits, or once the account's counters say so; never to
 * a paid tier; gone again when a fresher account read shows headroom.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AbacusAccountInfo } from "#shared/contracts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const account = vi.hoisted(() => ({
  current: null as AbacusAccountInfo | null,
  updatedAt: 0,
}));

vi.mock("../../hooks/use-abacus-account", () => ({
  useAbacusAccountQuery: () => ({
    data: account.current,
    dataUpdatedAt: account.updatedAt,
  }),
}));

const { CreditsExhaustedCard, shouldShowCreditsCard } =
  await import("./credits-exhausted-card");
const { useCreditsStore } = await import("../../stores/credits-store");

const free = (over: Partial<AbacusAccountInfo> = {}): AbacusAccountInfo => ({
  user_id: "u1",
  organization_id: "o1",
  name: "Ada",
  email: "ada@example.com",
  picture: null,
  organization: null,
  org_user_count: null,
  plan: "Free",
  subscription_tier: "free",
  credits_used: 10,
  credits_granted: 100,
  ...over,
});

const getAbacusAccount = vi.fn(async () => account.current);

const renderCard = () =>
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <CreditsExhaustedCard />
      </QueryClientProvider>
    ) as JSX.Element
  );

const card = () => document.querySelector('[data-id="sidebar-credits-card"]');
const dismiss = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-id="sidebar-credits-card-dismiss"]'
  );

beforeEach(() => {
  localStorage.clear();
  useCreditsStore.setState({ exhaustedAt: null });
  account.current = free();
  account.updatedAt = 0;
  getAbacusAccount.mockClear();
  Object.assign(window, {
    api: { agent: { getAbacusAccount }, openExternal: vi.fn() },
  });
});

describe("shouldShowCreditsCard", () => {
  it("shows for the free plan once a turn has died for want of credits", () => {
    const now = 1_000_000;
    expect(
      shouldShowCreditsCard({ account: free(), exhaustedAt: now - 1, now })
    ).toBe(true);
  });

  it("shows when the account's own counters say the credits are spent", () => {
    expect(
      shouldShowCreditsCard({
        account: free({ credits_used: 100, credits_granted: 100 }),
        exhaustedAt: null,
      })
    ).toBe(true);
  });

  it("stays away from a free plan with headroom and no mark", () => {
    expect(shouldShowCreditsCard({ account: free(), exhaustedAt: null })).toBe(
      false
    );
  });

  it("tells a paid tier that ran out, without selling them their own plan", () => {
    // The card is still owed — their turns have stopped — but the copy is
    // the paid one; an Upgrade pitch would point at the plan they pay for.
    expect(
      shouldShowCreditsCard({
        account: free({ subscription_tier: "pro", credits_used: 500 }),
        exhaustedAt: Date.now(),
      })
    ).toBe(true);
  });

  it("says nothing at all while the account is still unknown", () => {
    // An unread account is not a free one. Reading it as free told a Pro user
    // who had run out to upgrade to the plan they were already paying for.
    expect(
      shouldShowCreditsCard({ account: null, exhaustedAt: Date.now() })
    ).toBe(false);
  });
});

describe("CreditsExhaustedCard", () => {
  it("upsells a free plan that still has credits, closably", () => {
    renderCard();
    expect(card()?.textContent).toContain("creditsCard.upsellTitle");
    expect(dismiss()).not.toBeNull();
  });

  it("stays closed once closed, and comes back when the credits run out", () => {
    renderCard();
    fireEvent.click(dismiss()!);
    expect(card()).toBeNull();

    // A reopened app: the dismissal is remembered, the upsell stays away.
    cleanup();
    renderCard();
    expect(card()).toBeNull();

    // Out of credits is not a pitch to be waved off; it is why nothing runs.
    cleanup();
    useCreditsStore.getState().markExhausted();
    renderCard();
    expect(card()?.textContent).toContain("creditsCard.title");
    expect(dismiss()).toBeNull();
  });

  it("still hands a spent free plan the way to upgrade", () => {
    // The basic-tier rule above must not take this with it: out of credits
    // is the one moment the upgrade button is the answer to the question.
    useCreditsStore.getState().markExhausted();
    renderCard();

    expect(card()?.textContent).toContain("creditsCard.title");
    expect(
      document.querySelector('[data-id="sidebar-credits-card-cta"]')
    ).not.toBeNull();
    // And no dismiss: closing it would hide why nothing runs.
    expect(dismiss()).toBeNull();
  });

  it("says nothing to a basic plan, which has the agent card instead", () => {
    // They already bought something; an upgrade pitch beside the Abacus AI
    // agent card reads as a nag rather than an offer.
    account.current = free({ subscription_tier: "basic" });
    renderCard();
    expect(card()).toBeNull();

    useCreditsStore.getState().markExhausted();
    cleanup();
    renderCard();
    expect(card()).toBeNull();
  });

  it("says nothing to a paid plan", () => {
    account.current = free({ subscription_tier: "pro" });
    renderCard();
    expect(card()).toBeNull();
  });

  it("renders the card and asks for fresh counters once marked", async () => {
    useCreditsStore.getState().markExhausted();
    renderCard();
    expect(card()).not.toBeNull();
    await waitFor(() => expect(getAbacusAccount).toHaveBeenCalledWith(true));
  });

  it("drops the mark when a fresher account read shows headroom", async () => {
    useCreditsStore.setState({ exhaustedAt: 1_000 });
    account.updatedAt = 2_000;
    renderCard();
    await waitFor(() =>
      expect(useCreditsStore.getState().exhaustedAt).toBeNull()
    );
    // Back to the upsell, which is what a free plan with headroom sees.
    expect(card()?.textContent).toContain("creditsCard.upsellTitle");
  });

  it("keeps the mark when the account read predates it", () => {
    const mark = Date.now() - 60_000;
    useCreditsStore.setState({ exhaustedAt: mark });
    account.updatedAt = mark - 60_000;
    renderCard();
    expect(useCreditsStore.getState().exhaustedAt).toBe(mark);
    expect(card()).not.toBeNull();
  });
});
