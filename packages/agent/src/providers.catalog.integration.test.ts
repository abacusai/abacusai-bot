/**
 * The invariant the connect page stands on: for every key-paste provider the
 * desktop offers, setting that one env var is enough for pi to surface the
 * provider's models — no registration call, no extra config.
 *
 * This is pi's own env discovery and bundled catalog doing the work
 * (env-api-keys and models.generated in pi-ai), which is exactly why it needs
 * pinning: a pi upgrade that renames an env var or drops a provider from its
 * catalog would break the feature while every line of this repo still
 * compiled. The mapping here is duplicated from the desktop's
 * PROVIDER_ENV_VARS on purpose — the agent cannot import the desktop's shared
 * module, and the duplication means a drift on either side fails a test.
 *
 * Also pinned: the exact model id PROVIDER_DEFAULTS starts a session on, and
 * every curated id the desktop picker offers for these providers, resolve in
 * pi's catalog — an id that fails to resolve strands the very user it was
 * added for.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultModelFor, PROVIDER_DEFAULTS } from "./config.js";
import { listModels, resolveModel } from "./providers.js";

/**
 * Env var → provider id, as pi reads them. The long-tail providers the
 * desktop's connect page collects keys for, minus the ones with their own
 * registration path (abacus, gemini) or their own auth flow (openai-codex).
 */
const KEY_LIT_PROVIDERS: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  DEEPSEEK_API_KEY: "deepseek",
  BASETEN_API_KEY: "baseten",
  CEREBRAS_API_KEY: "cerebras",
  FIREWORKS_API_KEY: "fireworks",
  GROQ_API_KEY: "groq",
  HF_TOKEN: "huggingface",
  MINIMAX_API_KEY: "minimax",
  MISTRAL_API_KEY: "mistral",
  MOONSHOT_API_KEY: "moonshotai",
  NVIDIA_API_KEY: "nvidia",
  OPENCODE_API_KEY: "opencode",
  TOGETHER_API_KEY: "together",
  AI_GATEWAY_API_KEY: "vercel-ai-gateway",
  XAI_API_KEY: "xai",
  ZAI_API_KEY: "zai",
};

/**
 * The picker's curated ids for the key-paste providers, copied from
 * MODEL_CATALOG in apps/desktop/src/shared/models.ts. Duplicated for the same
 * reason the env-var map above is: the agent cannot import the desktop's
 * shared module, and a copy means drift on either side fails a test —
 * models.test.ts holds the other half of the pair.
 *
 * Excluded on purpose: openllm/auto (virtual, resolved before pi sees it),
 * and the abacus, gemini and openai-codex ids, whose providers register
 * through their own path rather than pi's env discovery.
 */
const CURATED_MODEL_IDS = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
  "cerebras/gpt-oss-120b",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "fireworks/accounts/fireworks/models/deepseek-v4-flash",
  "groq/openai/gpt-oss-120b",
  "huggingface/deepseek-ai/DeepSeek-V4-Flash",
  "minimax/MiniMax-M3",
  "mistral/devstral-medium-latest",
  "mistral/mistral-large-latest",
  "moonshotai/kimi-k2.7-code",
  "moonshotai/kimi-k3",
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "opencode/deepseek-v4-flash",
  "openrouter/google/gemma-4-31b-it:free",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/openai/gpt-oss-20b:free",
  "together/deepseek-ai/DeepSeek-V4-Flash-0731",
  "vercel-ai-gateway/anthropic/claude-sonnet-5",
  "xai/grok-4.6",
  "xai/grok-build-0.1",
  "zai/glm-5.2",
];

let agentDir: string;
let runtime: ModelRuntime;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Every key set to a placeholder before the runtime is created: availability
  // is computed from the environment at startup. Values are never sent
  // anywhere — the catalog is bundled and network refresh is off.
  for (const envVar of Object.keys(KEY_LIT_PROVIDERS)) {
    savedEnv[envVar] = process.env[envVar];
    process.env[envVar] = "test-key";
  }

  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-catalog-"));
  // Not createModelRuntime: that turns catalog refresh on, and a test must
  // judge the bundled catalog offline rather than whatever the network says.
  runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsStorePath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
});

afterAll(() => {
  for (const [envVar, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[envVar];
    else process.env[envVar] = value;
  }
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("a key alone lights the provider up", () => {
  it("surfaces at least one model for every key-paste provider", () => {
    const byProvider = new Set(
      listModels(new ModelRegistry(runtime)).map((model) => model.provider)
    );

    for (const provider of Object.values(KEY_LIT_PROVIDERS)) {
      expect(
        byProvider.has(provider),
        `no models surfaced for "${provider}" — did pi rename its env var or drop its catalog?`
      ).toBe(true);
    }
  });
});

describe("every session-start default", () => {
  it("resolves in pi's catalog", () => {
    for (const entry of PROVIDER_DEFAULTS) {
      // openllm/auto is this app's virtual id, resolved before pi sees it.
      if (entry.model === "openllm/auto") continue;

      const { model, error } = resolveModel(runtime, entry.model);

      expect(error, `${entry.model}: ${error ?? ""}`).toBeUndefined();
      expect(model, `${entry.model} did not resolve`).toBeDefined();
    }
  });

  it("resolves every curated id the picker offers", () => {
    for (const id of CURATED_MODEL_IDS) {
      const { model, error } = resolveModel(runtime, id);

      expect(error, `${id}: ${error ?? ""}`).toBeUndefined();
      expect(model, `${id} did not resolve`).toBeDefined();
    }
  });

  it("picks each long-tail provider's default when its key is the only one", () => {
    for (const [envVar, provider] of Object.entries(KEY_LIT_PROVIDERS)) {
      const chosen = defaultModelFor({ [envVar]: "test-key" });

      expect(chosen, `no default for ${envVar}`).not.toBeNull();
      // The default must belong to the provider that key unlocks — openllm is
      // legitimate for the pool keys (OpenRouter and friends).
      expect(
        chosen === "openllm/auto" || chosen?.startsWith(`${provider}/`),
        `${envVar} starts on ${chosen ?? "nothing"}`
      ).toBe(true);
    }
  });
});
