import { describe, expect, it } from "vitest";

import {
  WEBSITE_PROMPT_MAX,
  websitePromptDecision,
  websitePromptSize,
  websitePromptText,
} from "./website-prompt";

describe("websitePromptText", () => {
  it.each<[unknown, string | null]>([
    ["Build a site for my bakery", "Build a site for my bakery"],
    ["  padded  ", "padded"],
    ["line one\nline two", "line one\nline two"],
    // A bidi override and a NUL read as spaces, never as hidden text.
    ["a‮b\u0000c", "a b c"],
    ["   ", null],
    ["", null],
    [null, null],
    [42, null],
    [{ text: "x" }, null],
  ])("%j", (value, expected) => {
    expect(websitePromptText(value)).toBe(expected);
  });

  it("cuts by code point", () => {
    const text = websitePromptText("😀".repeat(WEBSITE_PROMPT_MAX + 5));
    expect(Array.from(text!)).toHaveLength(WEBSITE_PROMPT_MAX);
    expect(text!.endsWith("😀")).toBe(true);
  });
});

describe("websitePromptDecision", () => {
  type Input = Parameters<typeof websitePromptDecision>[0];
  const base: Input = {
    prompt: "Make a game",
    taken: false,
    sessions: 0,
    draft: "",
  };
  it.each<[string, Partial<Input>, ReturnType<typeof websitePromptDecision>]>([
    ["fresh install runs it", {}, { kind: "run", prompt: "Make a game" }],
    ["no prompt", { prompt: null }, null],
    ["blank prompt", { prompt: "  " }, null],
    ["already taken on this install", { taken: true }, null],
    [
      "an install with chats",
      { sessions: 2 },
      { kind: "skip", reason: "has_sessions" },
    ],
    [
      "the person typed first",
      { draft: "my own words" },
      { kind: "skip", reason: "typed" },
    ],
    [
      "whitespace is not typing",
      { draft: "  \n" },
      { kind: "run", prompt: "Make a game" },
    ],
  ])("%s", (_name, change, expected) => {
    expect(websitePromptDecision({ ...base, ...change })).toEqual(expected);
  });
});

describe("websitePromptSize", () => {
  it.each<[number, string]>([
    [10, "short"],
    [60, "short"],
    [61, "medium"],
    [201, "long"],
  ])("%i characters", (length, size) => {
    expect(websitePromptSize("x".repeat(length))).toBe(size);
  });
});
