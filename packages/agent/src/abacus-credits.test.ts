/** What an Abacus request billed: read off its stream's last chunk, summed per turn. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abacusStreamSimple,
  addCredits,
  billedPointsOf,
  type MeteredMessage,
  turnCredits,
} from "./abacus-credits.js";

const sse = (...frames: unknown[]) =>
  `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;

const chunk = (delta: object, extra: object = {}) => ({
  id: "c1",
  object: "chat.completion.chunk",
  model: "m",
  created: 1,
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

const model = {
  id: "route-llm-code-low",
  name: "RouteLLM",
  api: "openai-completions",
  provider: "abacus",
  baseUrl: "https://routellm.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
  compat: { supportsDeveloperRole: false },
} as never;

/** One streamed request through the provider, its body split mid-frame. */
const run = async (body: string): Promise<MeteredMessage> => {
  const bytes = new TextEncoder().encode(body);
  const cut = Math.floor(bytes.length / 2);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut));
              controller.enqueue(bytes.slice(cut));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    )
  );
  const stream = abacusStreamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    { apiKey: "k" }
  );
  return (await stream.result()) as MeteredMessage;
};

afterEach(() => vi.unstubAllGlobals());

describe("abacus credits", () => {
  it("stamps the billed credits from the last chunk on the message", async () => {
    const message = await run(
      sse(
        chunk({ role: "assistant", content: "Hello" }),
        chunk(
          { content: "" },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
              compute_points_used: 1840,
              credits_used: 18.4,
            },
          }
        )
      )
    );
    expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(message.usage.input).toBe(10);
    expect(message.abacusCredits).toBe(18.4);
  });

  it("stamps nothing when an older server sends tokens only", async () => {
    const message = await run(
      sse(
        chunk({ role: "assistant", content: "Hello" }),
        chunk(
          {},
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          }
        )
      )
    );
    expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(message.abacusCredits).toBeUndefined();
  });

  it.each([
    ["a usage line", 'data: {"usage":{"compute_points_used":250}}', 250],
    ["zero", 'data: {"usage":{"compute_points_used":0}}', 0],
    [
      "model text quoting the key",
      'data: {"choices":[{"delta":{"content":"\\"compute_points_used\\": 9"}}]}',
      null,
    ],
    ["a negative value", 'data: {"usage":{"compute_points_used":-1}}', null],
    ["not a data line", ": compute_points_used 5", null],
    ["broken JSON", 'data: {"usage":{"compute_points_used":5', null],
  ])("reads %s", (_name, line, points) => {
    expect(billedPointsOf(line)).toBe(points);
  });

  it.each([
    [
      "no Abacus request",
      [{ role: "assistant", provider: "openai", content: [{}] }],
      undefined,
    ],
    [
      "every request billed",
      [
        {
          role: "assistant",
          provider: "abacus",
          abacusCredits: 1.5,
          content: [{}],
        },
        { role: "toolResult" },
        {
          role: "assistant",
          provider: "abacus",
          abacusCredits: 2.25,
          content: [{}],
        },
      ],
      3.75,
    ],
    [
      "a request that failed before it streamed",
      [
        {
          role: "assistant",
          provider: "abacus",
          stopReason: "error",
          content: [],
        },
        {
          role: "assistant",
          provider: "abacus",
          abacusCredits: 2,
          content: [{}],
        },
      ],
      2,
    ],
    [
      "a request with no charge (an older server)",
      [
        {
          role: "assistant",
          provider: "abacus",
          abacusCredits: 2,
          content: [{}],
        },
        { role: "assistant", provider: "abacus", content: [{}] },
      ],
      null,
    ],
  ])("a turn with %s", (_name, messages, credits) => {
    expect(turnCredits(messages)).toBe(credits);
  });

  it.each([
    [undefined, undefined, undefined],
    [undefined, 2, 2],
    [3, undefined, 3],
    [3, 2, 5],
    [null, 2, null],
    [3, null, null],
  ])("adds %s and %s", (a, b, sum) => {
    expect(addCredits(a, b)).toBe(sum);
  });
});
