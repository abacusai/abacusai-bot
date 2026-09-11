import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The pruner rewrites what the summarizer reads. The dangerous mistake would
 * be rewriting what the SESSION holds — those message objects are the
 * transcript, and editing one in place would corrupt history to save tokens.
 */
import { describe, expect, it } from "vitest";

import pruner from "./compaction-pruner.js";

const HUGE = "z".repeat(9_000);

function message(overrides: Record<string, unknown>) {
  return {
    role: "toolResult",
    toolName: "bash",
    isError: false,
    content: [],
    ...overrides,
  };
}

async function prune(messages: unknown[]) {
  const pi = fakePi();
  pruner(pi.api as never);
  const preparation = { messagesToSummarize: messages };
  await pi.fire("session_before_compact", { preparation });

  return preparation.messagesToSummarize;
}

describe("what gets pruned", () => {
  it("replaces a bulky tool result with a placeholder naming the tool", async () => {
    const [pruned] = (await prune([
      message({ content: [{ type: "text", text: HUGE }] }),
    ])) as Array<{ content: Array<{ text: string }> }>;

    expect(pruned!.content[0]!.text.length).toBeLessThan(200);
    expect(pruned!.content[0]!.text).toMatch(/bash output/);
    expect(pruned!.content[0]!.text).toMatch(/9000 chars/);
  });

  it("keeps a saved-output id, so the model can still find the full text", async () => {
    const [pruned] = (await prune([
      message({ content: [{ type: "text", text: `${HUGE} out-7 tail` }] }),
    ])) as Array<{ content: Array<{ text: string }> }>;

    expect(pruned!.content[0]!.text).toMatch(/out-7/);
  });
});

describe("what survives", () => {
  it("leaves a short result alone — often it is the whole answer", async () => {
    const short = message({
      toolName: "run_tests",
      content: [{ type: "text", text: "3 passed, 0 failed" }],
    });
    const [result] = await prune([short]);

    // Same object, not a rewritten copy.
    expect(result).toBe(short);
  });

  it("keeps the head of an error, because what broke belongs in a summary", async () => {
    const [pruned] = (await prune([
      message({
        toolName: "run_tests",
        isError: true,
        content: [{ type: "text", text: `boom ${"e".repeat(9_000)}` }],
      }),
    ])) as Array<{ content: Array<{ text: string }> }>;

    expect(pruned!.content[0]!.text.startsWith("boom")).toBe(true);
    // Still trimmed, though — an error is worth its tokens, not unlimited ones.
    expect(pruned!.content[0]!.text.length).toBeLessThan(2_000);
  });

  it("never touches user or assistant messages", async () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "please fix it" }],
    };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(9_000) }],
    };
    const [a, b] = await prune([user, assistant]);

    expect(a).toBe(user);
    expect(b).toBe(assistant);
  });

  it("leaves non-text blocks alone — prose cannot stand in for a screenshot", async () => {
    const withImage = message({
      content: [{ type: "image", source: { data: "x".repeat(9_000) } }],
    });
    const [result] = await prune([withImage]);

    expect(result).toBe(withImage);
  });
});

describe("the session transcript", () => {
  it("is never mutated — pruning builds new objects", async () => {
    const block = { type: "text", text: `${HUGE} tail` };
    const original = message({ content: [block] });
    const originalText = block.text;

    const [pruned] = await prune([original]);

    // The array handed to the summarizer changed; the entries the session
    // holds did not.
    expect(pruned).not.toBe(original);
    expect(original.content[0]).toBe(block);
    expect(block.text).toBe(originalText);
  });

  it("does nothing at all when there is nothing worth pruning", async () => {
    const pi = fakePi();
    pruner(pi.api as never);
    const messages = [message({ content: [{ type: "text", text: "small" }] })];
    const preparation = { messagesToSummarize: messages };

    await pi.fire("session_before_compact", { preparation });

    // The same array object, untouched — no needless churn on the way to a
    // summarizer that would have been fine either way.
    expect(preparation.messagesToSummarize).toBe(messages);
  });

  it("survives a preparation with no messages", async () => {
    const pi = fakePi();
    pruner(pi.api as never);

    await expect(
      pi.fire("session_before_compact", {
        preparation: { messagesToSummarize: [] },
      })
    ).resolves.toBeUndefined();
  });
});
