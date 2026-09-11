/**
 * A bot answers everyone the user allowed. The old rule let it stay quiet
 * on "broadcasts and automated content", and a model read a contact saved
 * as "My Airtel" as a telco robot and sent nothing — to the user's own
 * second number.
 */
import { describe, expect, it } from "vitest";

import { botOperatingPrompt } from "./bot-prompts.js";

describe("the bot's reply rule", () => {
  it("answers every message from an allowed sender", () => {
    const prompt = botOperatingPrompt();
    expect(prompt).toMatch(/every message gets an answer/i);
    expect(prompt).toMatch(/never judge a sender to be automated/i);
    expect(prompt).not.toMatch(/broadcasts, automated content/i);
  });

  it("keeps NO_REPLY only for its own echo", () => {
    expect(botOperatingPrompt()).toMatch(
      /NO_REPLY is only for your\s+own words echoing back/i
    );
  });
});
