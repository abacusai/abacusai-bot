/**
 * The shape check the connect page applies before storing a key.
 *
 * It is not a validity check and cannot be one — only a real request proves a
 * key works. What it does is refuse the paste that could not be a key at all,
 * so a mistake shows up in the field the user is looking at rather than as an
 * auth error part-way through their first conversation.
 */
import { describe, expect, it } from "vitest";

import { isPlausibleApiKey } from "./settings";

describe("keys that should be stored", () => {
  it.each([
    ["an OpenAI-style key", "sk-proj-Ab12Cd34Ef56Gh78"],
    ["an Anthropic-style key", "sk-ant-api03-aBcDeF_gHiJkL-123"],
    ["a Groq-style key", "gsk_0123456789abcdefghij"],
    ["a Hugging Face token", "hf_QwErTyUiOpAsDfGhJkL"],
    ["a bare opaque token", "0123456789abcdef"],
  ])("accepts %s", (_label, key) => {
    expect(isPlausibleApiKey(key)).toBe(true);
  });

  it("accepts a key with surrounding whitespace, which is trimmed on save", () => {
    expect(isPlausibleApiKey("  sk-proj-Ab12Cd34Ef56  ")).toBe(true);
  });
});

describe("pastes that are not a key", () => {
  it.each([
    ["nothing", ""],
    ["a fragment too short to be one", "sk-ab"],
    ["a whole shell assignment", "XAI_API_KEY=xai-Ab12Cd34Ef56"],
    ["an export line", "export OPENAI_API_KEY=sk-proj-Ab12Cd34"],
    ["a console URL", "https://console.groq.com/keys"],
    ["a key with the label in front of it", "API key sk-proj-Ab12Cd34"],
    ["two lines at once", "sk-proj-Ab12Cd34\nsk-proj-Ef56Gh78"],
    ["a tab in the middle", "sk-proj\tAb12Cd34"],
  ])("rejects %s", (_label, value) => {
    expect(isPlausibleApiKey(value)).toBe(false);
  });
});
