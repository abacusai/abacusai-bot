/**
 * The router as both loops drive it. The case that made it: an account
 * whose Abacus credits were gone, a Gemini key beside them, and a bot that
 * asked Abacus on every turn because nothing recorded the refusal.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CooldownEntries, CooldownStore } from "./openllm-cooldowns.js";
import type { ModelChoice } from "./providers.js";

const pool = vi.hoisted(() => ({ models: [] as ModelChoice[] }));
vi.mock("./providers.js", () => ({
  listModels: () => pool.models,
}));

const { OpenLlmRouter } = await import("./openllm-router.js");

const choice = (id: string, free = true): ModelChoice => ({
  provider: id.split("/")[0]!,
  modelId: id.split("/").slice(1).join("/"),
  id,
  label: id,
  free,
  inputCost: 0,
  reasoning: false,
  contextWindow: 128_000,
  // An Abacus model is pooled only when the platform's catalog says so.
  ...(id.startsWith("abacus/") ? { poolEligible: true, poolRank: 0 } : {}),
});

/** What a file store keeps between chats, in memory. */
const memoryStore = (): CooldownStore => {
  let entries: CooldownEntries = {};
  return {
    read: () => ({ ...entries }),
    write: (next) => {
      entries = { ...entries, ...next };
    },
  };
};

const registry = {} as ModelRegistry;
const OUT_OF_CREDITS =
  '429: {"message":"You have no remaining credits to use the LLM apis.","type":"insufficient_quota"}';

beforeEach(() => {
  pool.models = [
    choice("abacus/muse-spark-1.3-contributor"),
    choice("gemini/gemini-3.6-flash"),
    choice("openrouter/big:free"),
  ];
});

describe("a provider that refuses the account", () => {
  it("is put out as a whole, and the next source takes the turn", () => {
    const router = new OpenLlmRouter(() => 1_000, memoryStore());
    expect(router.pick(registry)?.id).toBe("abacus/muse-spark-1.3-contributor");

    const next = router.failed(registry, OUT_OF_CREDITS, {
      provider: "abacus",
      id: "muse-spark-1.3-contributor",
    });

    expect(next).toEqual({ nextId: "gemini/gemini-3.6-flash" });
    expect(router.poolShut(registry)).toBe(false);
  });

  it("stays out for the next chat, which starts on the next source", () => {
    const store = memoryStore();
    const first = new OpenLlmRouter(() => 1_000, store);
    first.failed(registry, OUT_OF_CREDITS, {
      provider: "abacus",
      id: "muse-spark-1.3-contributor",
    });

    // A new chat is a new process with a new router on the same file.
    const second = new OpenLlmRouter(() => 2_000, store);
    expect(second.pick(registry)?.id).toBe("gemini/gemini-3.6-flash");
  });

  it("shuts the pool once every source has refused", () => {
    pool.models = [choice("abacus/muse-spark-1.3-contributor")];
    const router = new OpenLlmRouter(() => 1_000, memoryStore());

    expect(
      router.failed(registry, OUT_OF_CREDITS, {
        provider: "abacus",
        id: "muse-spark-1.3-contributor",
      })
    ).toBeNull();
    expect(router.poolShut(registry)).toBe(true);
  });
});

describe("a model that merely failed", () => {
  it("sits out on its own and is not returned to this turn", () => {
    pool.models = [
      choice("openrouter/big:free"),
      choice("openrouter/small:free"),
    ];
    const router = new OpenLlmRouter(() => 1_000, memoryStore());

    const next = router.failed(registry, "429: rate limited upstream", {
      provider: "openrouter",
      id: "big:free",
    });
    expect(next).toEqual({ nextId: "openrouter/small:free" });

    // The second model fails too: nothing is left this turn, whatever the
    // cooldown clock says about the first.
    expect(
      router.failed(registry, "429: rate limited upstream", {
        provider: "openrouter",
        id: "small:free",
      })
    ).toBeNull();

    // A new turn may ask the soonest-free one again.
    router.beginTurn();
    expect(router.pick(registry)).toBeDefined();
  });

  it("starts from a clean sheet once it answers", () => {
    pool.models = [
      choice("openrouter/big:free"),
      choice("openrouter/small:free"),
    ];
    let now = 1_000;
    const router = new OpenLlmRouter(() => now, memoryStore());
    router.failed(registry, "429: rate limited upstream", {
      provider: "openrouter",
      id: "big:free",
    });
    router.beginTurn();
    now += 1;
    expect(router.pick(registry)?.id).toBe("openrouter/small:free");

    router.succeeded("openrouter/big:free");
    expect(router.pick(registry)?.id).toBe("openrouter/big:free");
  });
});
