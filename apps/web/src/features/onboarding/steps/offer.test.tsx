import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { FirstResultOfferMark } from "@abacus-ai/contract/first-result-offer";
import { render } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixedT, initI18n } from "#renderer/lib/i18n";

import type { StepContext } from "./context";
import { OfferStep } from "./offer";

const state = vi.hoisted(() => ({
  billing: null as BillingPlan | null,
  mark: null as FirstResultOfferMark | null,
  updatePrefs: vi.fn(async (_patch: unknown) => {}),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data: state.billing,
    isSuccess: state.billing != null,
    isError: false,
  }),
}));
vi.mock("#renderer/data/db", () => ({
  useDb: () => ({ updatePrefs: state.updatePrefs }),
}));
vi.mock("#renderer/data/db/prefs", async (original) => {
  const actual = await original<typeof import("#renderer/data/db/prefs")>();
  return {
    ...actual,
    usePrefs: () => ({
      ...actual.DEFAULT_PREFS,
      dismissals: {
        ...actual.DEFAULT_PREFS.dismissals,
        firstResultOffer: state.mark,
      },
    }),
  };
});
vi.mock("#renderer/lib/upgrade-dialog", () => ({
  startPlanCheckout: vi.fn(),
}));

const plan = (onboardingOffer?: BillingPlan["onboardingOffer"]) =>
  ({
    upgrades: [{ planName: "Basic", price: 10, url: null }],
    onboardingOffer,
  }) as unknown as BillingPlan;

const setup = () => {
  const funnelStep = vi.fn(async (_input: { step: string }) => {});
  const transport = {
    orpc: {
      account: { billingPlan: { queryOptions: () => ({ queryKey: ["b"] }) } },
    },
    client: { system: { funnelStep } },
  } as never;
  const ctx: StepContext = {
    props: {
      step: "offer",
      transport,
      facts: { signedIn: true, payingTier: false, ownsBot: false },
      planPitch: () => null,
    } as unknown as StepContext["props"],
    t: fixedT(),
    busy: false,
    perform: async (action) => {
      await action();
    },
    advance: vi.fn(),
    back: vi.fn(),
  };
  const view = render(<OfferStep ctx={ctx} heading={createRef()} />);
  const steps = () => funnelStep.mock.calls.map(([input]) => input.step);
  return { ctx, view, steps };
};

describe("OfferStep and the onboarding offer test", () => {
  beforeEach(async () => {
    await initI18n();
    state.mark = null;
    state.updatePrefs.mockClear();
  });

  it("shows the offer where the platform keeps it in onboarding", () => {
    state.billing = plan("onboarding");
    const { ctx, view, steps } = setup();
    expect(ctx.advance).not.toHaveBeenCalled();
    expect(view.container.querySelector("[data-slot=upgrade-price]")).not.toBe(
      null
    );
    expect(steps()).toEqual(["onboarding_offer_shown"]);
    expect(state.updatePrefs).not.toHaveBeenCalled();
  });

  it("shows the offer for an older server that sends no arm", () => {
    state.billing = plan(undefined);
    const { ctx, steps } = setup();
    expect(ctx.advance).not.toHaveBeenCalled();
    expect(steps()).toEqual(["onboarding_offer_shown"]);
  });

  it("holds the offer for the first result: stamped, counted, never drawn", () => {
    state.billing = plan("after_first_result");
    const { ctx, view, steps } = setup();
    expect(ctx.advance).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("[data-slot=upgrade-price]")).toBe(
      null
    );
    expect(steps()).toEqual(["onboarding_offer_held"]);
    expect(state.updatePrefs).toHaveBeenCalledWith({
      dismissals: {
        firstResultOffer: {
          heldAt: expect.any(Number),
          shownOn: null,
          answered: null,
        },
      },
    });
  });

  it("passes through again without restamping an offer already held", () => {
    state.billing = plan("after_first_result");
    state.mark = { heldAt: 1, shownOn: "reply-1", answered: null };
    const { ctx, steps } = setup();
    expect(ctx.advance).toHaveBeenCalledTimes(1);
    expect(steps()).toEqual([]);
    expect(state.updatePrefs).not.toHaveBeenCalled();
  });
});
