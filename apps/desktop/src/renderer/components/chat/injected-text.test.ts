import { describe, expect, it } from "vitest";

import { visibleUserText } from "./injected-text";

describe("visibleUserText", () => {
  it("leaves a real message alone", () => {
    expect(visibleUserText("can you check the logs")).toBe(
      "can you check the logs"
    );
  });

  it("keeps the user's words and drops the environment notice", () => {
    expect(
      visibleUserText(
        [
          "can you check the logs",
          "",
          "<system_reminder>",
          "Skills available (8): Code review, Debugging",
          "</system_reminder>",
        ].join("\n")
      )
    ).toBe("can you check the logs");
  });

  it("hides a routine fire entirely, notice and all", () => {
    expect(
      visibleUserText(
        [
          '[routine] "OnSlack" fired on its schedule at 31/8/2026, 1:05:00 pm.',
          "This is the app's scheduler speaking, not the user typing.",
          "",
          "On slack if someone tags me - reply for me.",
          "",
          "<system_reminder>",
          "This is what you are connected to in this session:",
          "</system_reminder>",
        ].join("\n")
      )
    ).toBe("");
  });

  it("strips every notice when a message carries more than one", () => {
    expect(
      visibleUserText(
        "<system_reminder>a</system_reminder>hi<system_reminder>b</system_reminder>"
      )
    ).toBe("hi");
  });
});
