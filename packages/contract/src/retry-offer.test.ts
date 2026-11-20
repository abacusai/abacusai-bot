import { describe, expect, it } from "vitest";

import { type RetryOfferTurn, retryOfferReason } from "./retry-offer";

const VIDEO_ASK = "Make a 30-second video for my bakery's new croissant";
const HANDOFF_REPLY =
  "Basic makes videos in Abacus AI Agent on the web: open it with the button.";

const turn = (over: Partial<RetryOfferTurn> = {}): RetryOfferTurn => ({
  ask: VIDEO_ASK,
  earlierAsks: [],
  reply: "Done.",
  ranWork: false,
  earlierRanWork: false,
  handedOff: false,
  ...over,
});

describe("retryOfferReason", () => {
  it.each<[string, Partial<RetryOfferTurn>, string | null]>([
    ["a repeated ask", { earlierAsks: [VIDEO_ASK] }, "repeat"],
    [
      "a repeated media ask answered by the plan",
      { earlierAsks: [VIDEO_ASK], reply: HANDOFF_REPLY, handedOff: true },
      null,
    ],
    [
      "work that failed",
      { ranWork: true, reply: "I couldn't build it." },
      "failed",
    ],
    [
      "work that failed, answered by the plan",
      { ranWork: true, reply: "I couldn't build it.", handedOff: true },
      null,
    ],
    [
      "a complaint after work",
      { ask: "It still doesn't work", earlierRanWork: true },
      "complaint",
    ],
    [
      "a complaint after work, answered by the plan",
      { ask: "It still doesn't work", earlierRanWork: true, handedOff: true },
      null,
    ],
    ["a first ask", {}, null],
  ])("%s", (_, over, expected) => {
    expect(retryOfferReason(turn(over))).toBe(expected);
  });
});
