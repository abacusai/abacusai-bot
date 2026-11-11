import { describe, expect, it } from "vitest";

import {
  cheaperModelOffer,
  isTopModel,
  planDefaultModel,
} from "./cheaper-model";
import type { ModelTier } from "./models";

const row = (
  id: string,
  tier: ModelTier,
  over: { configured?: boolean; access?: string; recommended?: boolean } = {}
) => ({ id, label: id, tier, configured: true, ...over });

const ROUTER = row("abacus/route-llm-code-low", "default", {
  recommended: true,
});
const OPUS = row("abacus/claude-opus-5-5", "strong");
const SONNET = row("abacus/claude-sonnet-5-5", "strong");
const FLASH = row("abacus/gemini-4-flash", "fast");
const CATALOG = [ROUTER, OPUS, SONNET, FLASH];

describe("cheaperModelOffer", () => {
  const offer = (over: Partial<Parameters<typeof cheaperModelOffer>[0]> = {}) =>
    cheaperModelOffer({
      plan: "paid",
      modelId: OPUS.id,
      listed: true,
      catalog: CATALOG,
      ...over,
    });

  it.each([
    ["a paid chat on Opus", {}, ROUTER.id],
    ["a paid chat on Sonnet", { modelId: SONNET.id }, ROUTER.id],
    [
      "an Opus the catalog prices as fast is still Opus by its id",
      { catalog: [ROUTER, row("abacus/claude-opus-5-5", "fast")] },
      ROUTER.id,
    ],
    [
      "a plan top model that is neither Opus nor Sonnet",
      {
        modelId: "abacus/gpt-6-1",
        catalog: [ROUTER, row("abacus/gpt-6-1", "fast")],
        planIds: ["abacus/gpt-6-1"],
      },
      ROUTER.id,
    ],
    [
      "another strong-priced model",
      {
        modelId: "abacus/gpt-6-1",
        catalog: [ROUTER, row("abacus/gpt-6-1", "strong")],
      },
      ROUTER.id,
    ],
    [
      "Pro's router (route-llm-code) is the plan's default",
      {
        catalog: [
          row("abacus/route-llm-code", "default", { recommended: true }),
          OPUS,
        ],
      },
      "abacus/route-llm-code",
    ],
    [
      "no recommended row: the low code router",
      { catalog: [row(ROUTER.id, "default"), OPUS] },
      ROUTER.id,
    ],
    ["the free plan", { plan: "free" as const }, null],
    ["an unread plan", { plan: null }, null],
    ["a bot's chat or a routine run", { listed: false }, null],
    ["already on the router", { modelId: ROUTER.id }, null],
    ["a cheap model", { modelId: FLASH.id }, null],
    ["no model resolved", { modelId: null }, null],
    ["a model the catalog lacks", { modelId: "abacus/claude-opus-9" }, null],
    [
      "the router does not run for this account",
      { catalog: [row(ROUTER.id, "default", { configured: false }), OPUS] },
      null,
    ],
    [
      "the router is locked",
      { catalog: [row(ROUTER.id, "default", { access: "locked" }), OPUS] },
      null,
    ],
    [
      "the recommended row is itself a top model",
      { catalog: [row(SONNET.id, "strong", { recommended: true }), OPUS] },
      null,
    ],
  ])("%s", (_name, over, expected) => {
    expect(offer(over)?.target.id ?? null).toBe(expected);
  });

  it("names the model the chat is on", () => {
    expect(offer()?.current.id).toBe(OPUS.id);
  });
});

describe("isTopModel", () => {
  it.each([
    [OPUS, true],
    [SONNET, true],
    [row("abacus/claude-sonnet-5-5-thinking", "fast"), false],
    [row("abacus/claude-haiku-5-5", "fast"), false],
    [ROUTER, false],
    [FLASH, false],
  ])("%o", (model, expected) => {
    expect(isTopModel(model)).toBe(expected);
  });
});

describe("planDefaultModel", () => {
  it("prefers the recommended row over the low router", () => {
    const pro = row("abacus/route-llm-code", "default", { recommended: true });
    expect(planDefaultModel([row(ROUTER.id, "fast"), pro])?.id).toBe(pro.id);
  });
});
