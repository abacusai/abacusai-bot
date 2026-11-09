import { describe, expect, it } from "vitest";

import { parseJsonReply } from "./phone/phone-upkeep.js";
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
  const { text, thinking } = splitReasoning(input);
  const whole = { text, thinking };

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
    const out = stream("<think>The answer is probably 42.", 4);

    expect(out.live).toBe("");
    expect(out.thinking).toBe("The answer is probably 42.");
    expect(out.text).toBe("<think>The answer is probably 42.");
    expect(splitReasoning("<think>cut off")).toEqual({
      text: "<think>cut off",
      thinking: "",
      reclaimed: true,
    });
  });

  it("takes several leading blocks in a row", () => {
    expect(
      everySplit("<think>first</think>\n<thinking>second</thinking>\nAnswer.")
    ).toEqual({ text: "Answer.", thinking: "firstsecond" });
  });

  it("allows a byte order mark before the block", () => {
    expect(everySplit("\uFEFF<think>plan</think>Answer.")).toEqual({
      text: "Answer.",
      thinking: "plan",
    });
  });

  it("reads a JSON reply past reasoning that contains braces", () => {
    expect(
      parseJsonReply(
        '<think>Shape is {"items": [...]}.</think>\n{"items": [1]}'
      )
    ).toEqual({ items: [1] });
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
