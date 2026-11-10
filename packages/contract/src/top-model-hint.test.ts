import { describe, expect, it } from "vitest";

import { currentPlanTopModelNames, type BillingPlan } from "./billing-plan";
import { retryOfferModel } from "./retry-offer";
import {
  EMPTY_TOP_MODEL_HINT_CARD,
  TOP_MODEL_HINT_QUIET_MS,
  type TopModelHintCard,
  topModelHintAllowed,
  topModelHintChoices,
  topModelHintCreditsSpent,
  topModelHintShowing,
  topModelHintShown,
} from "./top-model-hint";

const NOW = 1_800_000_000_000;
const card = (over: Partial<TopModelHintCard> = {}): TopModelHintCard => ({
  ...EMPTY_TOP_MODEL_HINT_CARD,
  ...over,
});

const row = (
  id: string,
  label: string,
  configured: boolean,
  access?: string
) => ({
  id: `abacus/${id}`,
  label,
  configured,
  ...(access != null ? { access } : {}),
});
const RUNNABLE = [
  row("route-llm-code-low", "RouteLLM", true),
  row("claude-opus-5-5-xhigh", "Claude Opus 5.5 XHigh", true),
  row("claude-opus-5-5", "Claude Opus 5.5", true),
  row("claude-sonnet-5-5", "Claude Sonnet 5.5", true),
];
const LOCKED = RUNNABLE.map((model) =>
  model.id.endsWith("low")
    ? model
    : { ...model, configured: false, access: "locked" }
);
const TOP = ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-6 Astra", "Gemini 4"];

describe("topModelHintAllowed", () => {
  const at = { threadId: "t1", now: NOW };
  it.each([
    ["a first chat", null, true],
    ["a new chat after one showing", card({ shown: 1, threads: ["t0"] }), true],
    ["the same chat again", card({ shown: 1, threads: ["t1"] }), false],
    ["three showings", card({ shown: 3, threads: ["a", "b", "c"] }), false],
    ["after a switch", card({ switched: true }), false],
    [
      "within the quiet time after a close",
      card({ dismissed: 1, dismissedAt: NOW - 1000 }),
      false,
    ],
    [
      "after the quiet time",
      card({ dismissed: 1, dismissedAt: NOW - TOP_MODEL_HINT_QUIET_MS }),
      true,
    ],
    [
      "after two closes",
      card({ dismissed: 2, dismissedAt: NOW - 10 * TOP_MODEL_HINT_QUIET_MS }),
      false,
    ],
  ])("%s", (_name, state, expected) => {
    expect(topModelHintAllowed(state, at)).toBe(expected);
  });
});

describe("topModelHintShown and topModelHintShowing", () => {
  it("counts the showing, remembers the chat, and stays up for that turn only", () => {
    const next = topModelHintShown(card({ shown: 1, threads: ["t0"] }), {
      threadId: "t1",
      turn: 2,
    });
    expect(next).toMatchObject({
      shown: 2,
      threads: ["t0", "t1"],
      shownThread: "t1",
      shownTurn: 2,
    });
    expect(topModelHintShowing(next, { threadId: "t1", turn: 2 })).toBe(true);
    expect(topModelHintShowing(next, { threadId: "t1", turn: 3 })).toBe(false);
    expect(
      topModelHintShowing(
        { ...next, switched: true },
        { threadId: "t1", turn: 2 }
      )
    ).toBe(false);
  });

  it("keeps at most the last 20 chats", () => {
    let state: TopModelHintCard = card();
    for (let index = 0; index < 25; index += 1)
      state = topModelHintShown(
        { ...state, shown: 0 },
        { threadId: `t${index}`, turn: 1 }
      );
    expect(state.threads).toHaveLength(20);
    expect(state.threads.at(-1)).toBe("t24");
  });
});

describe("topModelHintCreditsSpent", () => {
  it.each([
    [1000, 14000, false],
    [7000, 14000, true],
    [null, 14000, false],
    [100, 0, false],
  ])("used %s of %s", (used, granted, expected) => {
    expect(
      topModelHintCreditsSpent({ credits_used: used, credits_granted: granted })
    ).toBe(expected);
  });
});

describe("topModelHintChoices", () => {
  it("leads with Sonnet, then Opus, each the exact model and not its XHigh lane", () => {
    expect(topModelHintChoices(TOP, RUNNABLE).map((model) => model.id)).toEqual(
      ["abacus/claude-sonnet-5-5", "abacus/claude-opus-5-5"]
    );
  });

  it("offers only what the plan runs now", () => {
    expect(topModelHintChoices(TOP, LOCKED)).toEqual([]);
    expect(
      topModelHintChoices(
        TOP,
        RUNNABLE.filter((model) => !model.label.includes("Sonnet"))
      ).map((model) => model.id)
    ).toEqual(["abacus/claude-opus-5-5"]);
    expect(topModelHintChoices([], RUNNABLE)).toEqual([]);
  });
});

describe("retryOfferModel", () => {
  it("offers a free plan the locked Opus, and a paying plan the Opus it runs", () => {
    expect(retryOfferModel(TOP, LOCKED)?.id).toBe("abacus/claude-opus-5-5");
    expect(retryOfferModel(TOP, LOCKED, "runnable")).toBeNull();
    expect(retryOfferModel(TOP, RUNNABLE, "runnable")?.id).toBe(
      "abacus/claude-opus-5-5"
    );
    expect(retryOfferModel(TOP, RUNNABLE)).toBeNull();
  });
});

describe("currentPlanTopModelNames", () => {
  it("reads the account's own plan, not the plan above it", () => {
    const billing = {
      current: {
        plan: "basic",
        planName: "Basic",
        creditsRemaining: 1,
        creditsGranted: 1,
        freeTierExpiresAt: null,
      },
      plans: [
        {
          plan: "basic",
          planName: "Basic",
          priceText: "",
          features: [
            "Top models including Claude Opus 5.5 and Claude Sonnet 5.5",
          ],
          creditsPerMonth: 1,
          current: true,
        },
        {
          plan: "pro",
          planName: "Pro",
          priceText: "",
          features: ["Top models including Model X"],
          creditsPerMonth: 2,
          current: false,
        },
      ],
      upgrades: [],
      topUpUrl: null,
      upgradeInMobileApp: false,
    } satisfies BillingPlan;
    expect(currentPlanTopModelNames(billing)).toEqual([
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
    ]);
    expect(currentPlanTopModelNames(null)).toEqual([]);
  });
});
