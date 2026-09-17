/**
 * The Abacus slice of OpenLLM's pool comes from the catalog's `route-llm-open`
 * entry: which models, in which order. The app only reads it.
 */
import { describe, expect, it } from "vitest";

import { abacusPool, OPEN_POOL_ID } from "./providers.js";

describe("the catalog's pool descriptor", () => {
  it("reads the members in the platform's order", () => {
    expect(
      abacusPool([
        { id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
        {
          id: OPEN_POOL_ID,
          pool: ["stealth/union-alpha", "deepseek-ai/DeepSeek-V4-Flash-0731"],
        },
      ])
    ).toEqual(["stealth/union-alpha", "deepseek-ai/DeepSeek-V4-Flash-0731"]);
  });

  it("is null on a catalog that predates it, so the tier inference stands", () => {
    expect(abacusPool([{ id: "route-llm-code-low" }])).toBeNull();
    expect(abacusPool([{ id: OPEN_POOL_ID }])).toBeNull();
  });

  it("keeps only well-formed ids", () => {
    expect(
      abacusPool([{ id: OPEN_POOL_ID, pool: ["a", "", 3, null, "b"] }])
    ).toEqual(["a", "b"]);
  });
});
