import { describe, expect, it } from "vitest";

import { BotOutputSanitizer, tidyBotText } from "./bot-output.js";

/** Run a whole string through in chunks of `size` and collect both channels. */
const run = (
  input: string,
  size: number
): { text: string; thinking: string } => {
  const sanitizer = new BotOutputSanitizer();
  let text = "";
  let thinking = "";

  for (let i = 0; i < input.length; i += size) {
    const out = sanitizer.push(input.slice(i, i + size));
    text += out.text;
    thinking += out.thinking;
  }

  const tail = sanitizer.flush();

  return { text: text + tail.text, thinking: thinking + tail.thinking };
};

describe("rerouting inline reasoning", () => {
  it("moves a <think> span to the thinking channel", () => {
    const { text, thinking } = run(
      "<think>The user wants a joke.</think>Here is a joke!",
      1000
    );

    expect(text).toBe("Here is a joke!");
    expect(thinking).toBe("The user wants a joke.");
  });

  it("survives tags split across streaming chunks", () => {
    // Chunk size 3 splits both the open and close tags mid-way — the exact
    // case a delta stream produces and a whole-string regex never sees.
    const { text, thinking } = run(
      "<think>hidden reasoning</think>visible answer",
      3
    );

    expect(text).toBe("visible answer");
    expect(thinking).toBe("hidden reasoning");
  });

  it("handles <reasoning> and mixed case", () => {
    const { text, thinking } = run(
      "<Reasoning>step by step</Reasoning>Done.",
      5
    );

    expect(text).toBe("Done.");
    expect(thinking).toBe("step by step");
  });

  it("routes an unterminated span to thinking rather than leaking it", () => {
    const { text, thinking } = run("<think>never closed...", 7);

    expect(text).toBe("");
    expect(thinking).toBe("never closed...");
  });

  it("leaves ordinary angle brackets alone", () => {
    const { text } = run("Use <b>bold</b> and a < b comparison.", 4);

    expect(text).toBe("Use <b>bold</b> and a < b comparison.");
  });
});

describe("tidying whole messages", () => {
  it("drops a leaked role prefix and collapses blank-line runs", () => {
    expect(tidyBotText("Assistant: Hello.\n\n\n\nBye.")).toBe("Hello.\n\nBye.");
  });
});
