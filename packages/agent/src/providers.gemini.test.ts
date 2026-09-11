/**
 * Gemini has to be registered on pi's native Google transport, not on an
 * OpenAI-compatible one.
 *
 * Google publishes an OpenAI-shaped endpoint and it is tempting to point at
 * it, but it cannot carry these models: it 400s any request carrying a field
 * it does not define (pi sends OpenAI's `store` to anything it does not know
 * to be non-standard), and Gemini 3 hands back a thought signature with every
 * tool call that it demands back on the next request, which the OpenAI wire
 * format has nowhere to put. Both faults are silent at compile time and total
 * at runtime — the first broke every turn, the second every turn with a tool
 * call — so the transport is pinned here rather than left to review.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerGeminiProvider } from "./providers.js";

const GEMINI_IDS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];

let agentDir: string;
let runtime: ModelRuntime;
let savedKey: string | undefined;

const registered = (): ModelRegistry => {
  const registry = new ModelRegistry(runtime);

  registerGeminiProvider(registry);

  return registry;
};

beforeAll(async () => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-gemini-"));
  savedKey = process.env.GEMINI_API_KEY;
  // Offline, like the catalog test: this judges what the code registers, not
  // what the network says today.
  runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsStorePath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
});

afterAll(() => {
  if (savedKey == null) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("the Gemini provider", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("registers nothing at all without a key", () => {
    delete process.env.GEMINI_API_KEY;

    expect(registered().getProvider("gemini")).toBeUndefined();
  });

  it("speaks the native Google API rather than an OpenAI-shaped one", async () => {
    const models =
      (await registered().getProvider("gemini")?.getModels()) ?? [];

    expect(models.map((model) => model.id).sort()).toEqual(
      [...GEMINI_IDS].sort()
    );

    for (const model of models) {
      expect(model.api).toBe("google-generative-ai");
      // The OpenAI-compatible surface lives under /openai on the same host, so
      // the suffix is the whole difference between the two.
      expect(model.baseUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta"
      );
    }
  });

  it("says that thinking cannot be turned off on either model", async () => {
    const models =
      (await registered().getProvider("gemini")?.getModels()) ?? [];

    expect(models).toHaveLength(GEMINI_IDS.length);
    // `off: null` is how pi's catalog marks a model that has no non-thinking
    // mode. Without it pi sends an off level, which these two reject outright.
    for (const model of models) {
      expect(model.thinkingLevelMap?.off).toBeNull();
    }
  });
});
