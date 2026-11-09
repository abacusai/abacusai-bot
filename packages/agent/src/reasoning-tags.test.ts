import { describe, expect, it } from "vitest";

import { ReasoningSplitter, splitReasoning } from "./reasoning-tags.js";

/** Stream `input` in chunks of `size`; `live` is what showed before the end. */
const stream = (
  input: string,
  size: number
): { text: string; thinking: string; live: string } => {
  const splitter = new ReasoningSplitter();
  let text = "";
  let thinking = "";

  for (let i = 0; i < input.length; i += size) {
    const out = splitter.push(input.slice(i, i + size));
    text += out.text;
    thinking += out.thinking;
  }

  const live = text;
  const tail = splitter.flush();

  return { text: text + tail.text, thinking: thinking + tail.thinking, live };
};

/** Every chunk size from 1 to the whole string gives the same split. */
const everySplit = (input: string): { text: string; thinking: string } => {
  const whole = splitReasoning(input);

  for (let size = 1; size <= input.length; size++) {
    const out = stream(input, size);
    expect({ text: out.text, thinking: out.thinking }, `chunk ${size}`).toEqual(
      whole
    );
  }

  return whole;
};

describe("leading reasoning blocks", () => {
  it("moves a leading block to thinking", () => {
    expect(
      everySplit("<think>The user wants a joke.</think>\n\nHere is a joke!")
    ).toEqual({ text: "Here is a joke!", thinking: "The user wants a joke." });
  });

  it("allows whitespace before the block, any case and the other tags", () => {
    expect(everySplit("\n  <Reasoning>step by step</Reasoning>Done.")).toEqual({
      text: "Done.",
      thinking: "step by step",
    });
    expect(everySplit("<thinking>a</thinking><reply>Hi</reply>")).toEqual({
      text: "<reply>Hi</reply>",
      thinking: "a",
    });
  });

  it("hides an unclosed leading block while streaming only", () => {
    const out = stream("<think>Ollama runs it; LM Studio needs 0.3.", 4);

    expect(out.live).toBe("");
    expect(out.thinking).toBe("Ollama runs it; LM Studio needs 0.3.");
    expect(out.text).toBe("<think>Ollama runs it; LM Studio needs 0.3.");
    expect(splitReasoning("<think>cut off").text).toBe("<think>cut off");
  });
});

describe("tags that are part of the reply", () => {
  it("keeps everything after a mention of the tag", () => {
    const reply =
      "The model wraps its reasoning in `<think>` tags, so the app hides it. " +
      "I tried four settings; the fix is option 2.";

    expect(everySplit(reply)).toEqual({ text: reply, thinking: "" });
  });

  it("keeps a closed block that is not at the start", () => {
    const reply = "Answer first.\n<think>aside</think>\nMore answer.";

    expect(everySplit(reply)).toEqual({ text: reply, thinking: "" });
  });

  it("keeps tags inside code fences and spans", () => {
    const reply =
      "```\n<think>\nplan\n</think>\nanswer\n```\nThen `</think>` closes it.";

    expect(everySplit(reply)).toEqual({ text: reply, thinking: "" });
  });

  it("keeps ordinary angle brackets", () => {
    const reply = "<b>bold</b> and a < b comparison.";

    expect(everySplit(reply)).toEqual({ text: reply, thinking: "" });
    expect(everySplit("<thin ice")).toEqual({
      text: "<thin ice",
      thinking: "",
    });
  });
});

describe("state across messages", () => {
  it("reset drops an open block", () => {
    const splitter = new ReasoningSplitter();

    splitter.push("<think>half");
    splitter.reset();
    expect(splitter.push("Hello")).toEqual({ text: "Hello", thinking: "" });
  });
});
