/**
 * The two questions the UI asks the catalog.
 *
 * "Can this app answer a message?" gates the composer, and it has to agree
 * with the model picker exactly — one of them deciding differently is a
 * blocked composer next to a dropdown full of models.
 *
 * "Is this a paid account?" routes onboarding. It reads the catalog rather
 * than the plan's display name, because a plan can be renamed and this cannot.
 */
import { describe, expect, it } from "vitest";

import {
  hasUsableModel,
  isAbacusSubscriber,
  type ModelAvailability,
} from "./models";

const model = (
  id: string,
  configured: boolean,
  provider = "abacus"
): ModelAvailability => ({
  id,
  label: id,
  provider,
  tier: "default",
  configured,
});

describe("whether anything can run", () => {
  it("is false with nothing configured", () => {
    expect(hasUsableModel([])).toBe(false);
    expect(hasUsableModel([model("abacus/x", false)])).toBe(false);
  });

  it("is false before the catalog has answered", () => {
    // Unknown is not "no": the composer must not grey out on a cold start.
    expect(hasUsableModel(undefined)).toBe(false);
    expect(hasUsableModel(null)).toBe(false);
  });

  it("counts any provider, not a favoured one", () => {
    // An OpenRouter key alone lights up OpenLLM's free pool, and that user is
    // as able to work as one holding an Abacus subscription.
    expect(hasUsableModel([model("openllm/auto", true, "openllm")])).toBe(true);
  });
});

describe("whether the account is a paid one", () => {
  it("says no for a free-tier catalog", () => {
    // Free tier is served the low code router but never the full one.
    expect(isAbacusSubscriber([model("abacus/route-llm-code-low", true)])).toBe(
      false
    );
  });

  it("says yes when the paid catalog's code router is there", () => {
    expect(
      isAbacusSubscriber([
        model("abacus/route-llm-code-low", true),
        model("abacus/route-llm-code", true),
      ])
    ).toBe(true);
  });

  it("does not count a router with no credential behind it", () => {
    expect(isAbacusSubscriber([model("abacus/route-llm-code", false)])).toBe(
      false
    );
    expect(isAbacusSubscriber(undefined)).toBe(false);
  });
});
