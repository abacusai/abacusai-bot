import { describe, expect, it } from "vitest";

import { planTopModelIds, type PlanTopModel } from "./billing-plan";
import { modelIdentity, retryOfferModel } from "./retry-offer";
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

// The billing plan's top models and the Abacus model list, in the shape and
// order the server sends them today.
const SERVER_TOP_MODELS: PlanTopModel[] = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", agentic: true },
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", agentic: true },
  { id: "gpt-6-luna", name: "GPT-6 Luna", agentic: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", agentic: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", agentic: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", agentic: true },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", agentic: true },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", agentic: false },
];
const PAID_LIST: [string, string][] = [
  ["route-llm-code-low", "RouteLLM"],
  ["gpt-6-luna", "GPT-6 Luna"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-fable-5-2", "Claude Fable 5.2"],
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
];
const runnable = (list: [string, string][]) =>
  list.map(([id, label]) => ({ id: `abacus/${id}`, label, configured: true }));
// A free account's locked rows: the top models, as the desktop builds them.
const locked = (top: PlanTopModel[]) => [
  { id: "abacus/route-llm-code-low", label: "RouteLLM", configured: true },
  ...top.map((model) => ({
    id: `abacus/${model.id}`,
    label: model.name,
    configured: false,
    access: "locked",
  })),
];
const ids = planTopModelIds({ topModels: SERVER_TOP_MODELS });
const rename = (top: PlanTopModel[], from: string, to: string) =>
  top.map((model) =>
    model.id === from ? { ...model, id: to, name: `${model.name} next` } : model
  );

describe("top models by identity, on the server's list shape", () => {
  it.each([
    [
      "today's list: Opus for a free retry, Opus for a paid one, Sonnet then Opus in the hint",
      locked(SERVER_TOP_MODELS),
      runnable(PAID_LIST),
      ids,
      ["abacus/claude-opus-5-5", "abacus/claude-opus-5-5"],
      ["abacus/claude-sonnet-5-5", "abacus/claude-opus-5-5"],
    ],
    [
      "the server reorders its list",
      locked([...SERVER_TOP_MODELS].reverse()),
      runnable([...PAID_LIST].reverse()),
      [...ids].reverse(),
      ["abacus/claude-opus-5-5", "abacus/claude-opus-5-5"],
      ["abacus/claude-sonnet-5-5", "abacus/claude-opus-5-5"],
    ],
    [
      "a version bump the pitch renames: Opus 5.5 to 5.6",
      locked(rename(SERVER_TOP_MODELS, "claude-opus-5-5", "claude-opus-5-6")),
      runnable([...PAID_LIST, ["claude-opus-5-6", "Opus next"]]),
      planTopModelIds({
        topModels: rename(
          SERVER_TOP_MODELS,
          "claude-opus-5-5",
          "claude-opus-5-6"
        ),
      }),
      ["abacus/claude-opus-5-6", "abacus/claude-opus-5-6"],
      ["abacus/claude-sonnet-5-5", "abacus/claude-opus-5-6"],
    ],
    [
      "a newer model the plan does not name yet: the plan's own wins",
      locked(SERVER_TOP_MODELS),
      runnable([["claude-opus-6-0-preview", "Opus preview"], ...PAID_LIST]),
      ids,
      ["abacus/claude-opus-5-5", "abacus/claude-opus-5-5"],
      ["abacus/claude-sonnet-5-5", "abacus/claude-opus-5-5"],
    ],
    [
      "an older server with no top models: the newest of each family",
      locked([]),
      runnable(PAID_LIST),
      [],
      [null, "abacus/claude-opus-5-5"],
      ["abacus/claude-sonnet-5-5", "abacus/claude-opus-5-5"],
    ],
    [
      "no Claude at all: the plan's first top model",
      locked(SERVER_TOP_MODELS.filter((m) => !m.id.startsWith("claude"))),
      runnable(PAID_LIST.filter(([id]) => !id.startsWith("claude"))),
      ids,
      ["abacus/gpt-6.1-sol", "abacus/gpt-6.1-sol"],
      [],
    ],
  ])("%s", (_name, free, paid, planIds, [freeRetry, paidRetry], hint) => {
    expect(retryOfferModel(free, "locked", planIds)?.id ?? null).toBe(
      freeRetry
    );
    expect(retryOfferModel(paid, "runnable", planIds)?.id ?? null).toBe(
      paidRetry
    );
    expect(topModelHintChoices(paid, planIds).map((m) => m.id)).toEqual(hint);
    // A locked row is never offered as runnable, nor a runnable one as locked.
    expect(retryOfferModel(free, "runnable", planIds)).toBeNull();
    expect(topModelHintChoices(free, planIds)).toEqual([]);
  });

  it("reads identity off the id: family words, version numbers, no date stamp", () => {
    expect(modelIdentity("abacus/claude-opus-5-5")).toEqual({
      family: "claude-opus",
      version: [5, 5],
    });
    expect(modelIdentity("abacus/claude-sonnet-4-5-20250929")).toEqual({
      family: "claude-sonnet",
      version: [4, 5],
    });
    expect(modelIdentity("abacus/claude-opus-5-5-thinking").family).toBe(
      "claude-opus-thinking"
    );
  });
});
