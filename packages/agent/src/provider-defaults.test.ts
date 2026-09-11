/**
 * Which model a session starts on, given whichever key the user has.
 *
 * A flat default was wrong for everyone whose key was not the one it named:
 * they started on a provider they had no credentials for and were then moved to
 * whatever happened to be first in a catalog. The mapping below is the contract
 * — one cheap, fast driver per provider — and the null case is what lets both
 * front ends say "configure a model" instead of failing on the first token.
 */
import { describe, expect, it } from "vitest";

import { defaultModelFor, PROVIDER_DEFAULTS } from "./config.js";
import { OPENLLM_ID } from "./openllm.js";

/** Only the variable under test is set, so nothing leaks in from the machine. */
const only = (envVar: string, value = "test-key"): NodeJS.ProcessEnv => ({
  [envVar]: value,
});

describe("one default per provider", () => {
  it("maps each provider to its cheap, fast driver", () => {
    expect(defaultModelFor(only("ANTHROPIC_API_KEY"))).toBe(
      "anthropic/claude-haiku-4-5"
    );
    expect(defaultModelFor(only("OPENAI_API_KEY"))).toBe("openai/gpt-5.6-luna");
    expect(defaultModelFor(only("DEEPSEEK_API_KEY"))).toBe(
      "deepseek/deepseek-v4-flash"
    );
    expect(defaultModelFor(only("ABACUS_API_KEY"))).toBe("openllm/auto");
    expect(defaultModelFor(only("OPENROUTER_API_KEY"))).toBe("openllm/auto");
    expect(defaultModelFor(only("GEMINI_API_KEY"))).toBe("openllm/auto");
  });

  it("gives the free-pool keys OpenLLM, not any single model", () => {
    // Every model on the free tier rate-limits; parking a session on one of
    // them dies on the first busy day. The router starts on the best model in
    // the pool and switches when it fails — see openllm.ts. An Abacus key
    // lands there too: the pool holds its cheap drivers (route-llm-code-low
    // leads that slice), and a free key added later widens the pool with no
    // default change.
    expect(defaultModelFor(only("OPENROUTER_API_KEY"))).toBe(OPENLLM_ID);
    expect(defaultModelFor(only("GEMINI_API_KEY"))).toBe(OPENLLM_ID);
    expect(defaultModelFor(only("ABACUS_API_KEY"))).toBe(OPENLLM_ID);
  });

  it("never names the Abacus chat router", () => {
    // route-llm short-circuits to a Flash model above 5000 tokens of context,
    // which a coding agent passes on its system prompt plus one tool result.
    // The pool has its own guard (see openllm.test.ts); this pins the default.
    expect(defaultModelFor(only("ABACUS_API_KEY"))).not.toBe(
      "abacus/route-llm"
    );
  });

  it("every entry carries a provider prefix the session can resolve", () => {
    // All but one go to pi's resolver; the free router's virtual id is
    // intercepted by the session first. Both shapes are `provider/model`.
    for (const { envVar, model } of PROVIDER_DEFAULTS) {
      expect(model, envVar).toContain("/");
      expect(model.startsWith("/"), envVar).toBe(false);
    }
  });
});

describe("no provider configured", () => {
  it("returns null rather than naming a model nobody can run", () => {
    expect(defaultModelFor({})).toBeNull();
  });

  it("treats an empty or blank key as absent", () => {
    // An exported-but-empty variable is the shape a half-finished shell profile
    // leaves behind, and picking its provider would fail on the first token.
    expect(defaultModelFor({ ANTHROPIC_API_KEY: "" })).toBeNull();
    expect(defaultModelFor({ ANTHROPIC_API_KEY: "   " })).toBeNull();
  });

  it("ignores a key for a provider with no default of its own", () => {
    // A variable no entry names — the shape any future provider's key has
    // until someone deliberately gives it a default.
    expect(defaultModelFor({ COHERE_API_KEY: "test-key" })).toBeNull();
  });
});

describe("when several keys are set", () => {
  it("follows the declared order rather than the environment order", () => {
    const all = {
      OPENROUTER_API_KEY: "k",
      OPENAI_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      ABACUS_API_KEY: "k",
      DEEPSEEK_API_KEY: "k",
    };

    expect(defaultModelFor(all)).toBe(PROVIDER_DEFAULTS[0]?.model);
  });

  it("keeps DeepSeek first, so an existing setup does not change model", () => {
    // DeepSeek was the flat default before this existed. Anyone who already had
    // a working configuration must keep the model they had.
    expect(PROVIDER_DEFAULTS[0]?.envVar).toBe("DEEPSEEK_API_KEY");
    expect(
      defaultModelFor({ DEEPSEEK_API_KEY: "k", ANTHROPIC_API_KEY: "k" })
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("falls to the next provider when the first key is blank", () => {
    expect(
      defaultModelFor({ DEEPSEEK_API_KEY: "  ", ABACUS_API_KEY: "k" })
    ).toBe(OPENLLM_ID);
  });

  it("lets the majors outrank the long tail", () => {
    // A Groq key next to a DeepSeek key must not move the session onto Groq:
    // the long-tail defaults exist for people whose ONLY key is one of them,
    // never to outrank the tuned default. The table's order is that priority.
    expect(defaultModelFor({ GROQ_API_KEY: "k", DEEPSEEK_API_KEY: "k" })).toBe(
      "deepseek/deepseek-v4-flash"
    );
    expect(defaultModelFor({ MISTRAL_API_KEY: "k", GEMINI_API_KEY: "k" })).toBe(
      OPENLLM_ID
    );
  });

  it("starts a long-tail-only setup on that provider's cheap driver", () => {
    expect(defaultModelFor({ GROQ_API_KEY: "k" })).toBe(
      "groq/openai/gpt-oss-120b"
    );
    expect(defaultModelFor({ MOONSHOT_API_KEY: "k" })).toBe(
      "moonshotai/kimi-k2.7-code"
    );
  });
});
