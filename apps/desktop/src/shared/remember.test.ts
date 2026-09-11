/**
 * What counts as being told to remember something.
 *
 * The false positives matter more than the misses: a wrongly-caught sentence
 * lands in every future prompt, while a missed one is repeated in a second.
 */
import { describe, expect, it } from "vitest";

import { detectRememberRequest } from "./remember";

describe("being told to remember", () => {
  it("stores what follows the instruction", () => {
    expect(detectRememberRequest("remember I like blue")).toBe("I like blue");
    expect(detectRememberRequest("Remember that I use pnpm")).toBe(
      "I use pnpm"
    );
    expect(detectRememberRequest("please remember to call me Sree")).toBe(
      "call me Sree"
    );
    expect(detectRememberRequest("remember: deploys go out on Fridays")).toBe(
      "deploys go out on Fridays"
    );
  });

  it("leaves questions alone", () => {
    // The word appears, but nothing is being asked to stick.
    expect(detectRememberRequest("do you remember the auth bug?")).toBeNull();
    expect(detectRememberRequest("remember the auth bug?")).toBeNull();
  });

  it("leaves statements about remembering alone", () => {
    expect(
      detectRememberRequest("I remember fixing this last week")
    ).toBeNull();
    expect(
      detectRememberRequest("the tests remember their own fixtures")
    ).toBeNull();
  });

  it("ignores the word on its own", () => {
    expect(detectRememberRequest("remember")).toBeNull();
    expect(detectRememberRequest("remember that")).toBeNull();
  });

  it("keeps the instruction and not the paste under it", () => {
    // "remember X" with a wall of context below is an instruction followed by
    // a paste; storing the paste is how memory stops being worth reading.
    expect(
      detectRememberRequest(
        "remember I deploy with turbo\n\n<500 lines of log>"
      )
    ).toBe("I deploy with turbo");
  });

  it("refuses a fact too long to carry in every prompt", () => {
    expect(detectRememberRequest(`remember ${"x".repeat(600)}`)).toBeNull();
  });
});
