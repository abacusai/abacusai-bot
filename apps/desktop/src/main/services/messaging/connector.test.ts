/**
 * The two preview filters that keep a chat-list sweep honest.
 *
 * Both come from one real transcript: "typing…" delivered as a message from
 * the sender, and the bot's own outgoing replies reported back in as inbound
 * — a badge left by an earlier real message keeps the row in the sweep, and
 * the preview then shows whatever was said LAST, direction unknown.
 */
import { describe, expect, it } from "vitest";

import {
  isEphemeralPreview,
  normalizeScrapedText,
  previewMatchesSent,
} from "./connector";

describe("isEphemeralPreview", () => {
  it("catches presence strings, with or without the ellipsis", () => {
    for (const text of [
      "typing…",
      "typing...",
      "Typing…",
      "recording audio…",
      "online",
    ])
      expect(isEphemeralPreview(text), text).toBe(true);
  });

  it("leaves real messages alone, even ones starting the same way", () => {
    for (const text of [
      "typing test now",
      "are you online later?",
      "recording audio for the podcast went well",
      "hey",
    ])
      expect(isEphemeralPreview(text), text).toBe(false);
  });
});

describe("previewMatchesSent", () => {
  /**
   * The report: a bot answering a group read its own replies back as incoming
   * messages and answered those, then answered the answers — including
   * commentary meant for the user, delivered to the group.
   *
   * A group preview names its speaker. Ours reads "You: ", which matched
   * nothing we had sent, so every outgoing message came straight back in.
   */
  it('sees through a group\'s "You:" prefix on our own message', () => {
    expect(previewMatchesSent(["on my way"], "You: on my way")).toBe(true);
  });

  it("sees through it when the preview is also clipped", () => {
    expect(
      previewMatchesSent(
        ["I appreciate the message, but I should clarify something"],
        "You: I appreciate the message, but I should…"
      )
    ).toBe(true);
  });

  it("still lets a real message from someone else through", () => {
    // Losing "Alice: " from the front does not turn her words into ours.
    expect(previewMatchesSent(["on my way"], "Alice: are you coming?")).toBe(
      false
    );
  });

  it("can mistake a prefixed message for an echo, and that is the trade", () => {
    // The honest limit of matching on text. "Reminder: pick up the keys" is a
    // message, not a speaker, so dropping its first word makes it look like
    // something we sent — and it would be skipped.
    //
    // Taken knowingly. Missing this costs one dropped message in a contrived
    // case; missing an echo costs a loop that spams a real group with the
    // bot's own words until someone notices, which is what happened. The
    // gateway's burst breaker is what stops that being unbounded either way.
    expect(
      previewMatchesSent(["pick up the keys"], "Reminder: pick up the keys")
    ).toBe(true);
  });

  it("matches the chunk that is actually previewed, not only the first", () => {
    // A long reply is chunked; the preview shows the last one.
    expect(previewMatchesSent(["part one", "part two"], "You: part two")).toBe(
      true
    );
  });

  it("matches our own text exactly", () => {
    expect(
      previewMatchesSent(
        "haha all good 😄 talk then?",
        "haha all good 😄 talk then?"
      )
    ).toBe(true);
  });

  it("matches a truncated preview of a longer send", () => {
    expect(
      previewMatchesSent(
        "only 2? how many of you are coming for badminton? we'll need enough to rotate",
        "only 2? how many of you are coming for…"
      )
    ).toBe(true);
  });

  it("does not match a genuine reply", () => {
    expect(
      previewMatchesSent("how many rackets do you all have?", "2 for now")
    ).toBe(false);
  });

  it("never matches when nothing was sent", () => {
    expect(previewMatchesSent(undefined, "anything")).toBe(false);
  });

  it("sees through WhatsApp's bidi wrapping", () => {
    // The exact failure from the field: the preview arrives as
    // \u202aHii!\u202c and the naive compare let the bot's own reply back
    // in as a message from the sender.
    expect(previewMatchesSent("Hii!", "\u202aHii!\u202c")).toBe(true);
  });

  it("guards every recent send, not only the last", () => {
    // A two-message reply left only its final chunk guarded; the first one
    // could echo back in as inbound.
    const ring = ["first part of the answer", "and the second"];
    expect(previewMatchesSent(ring, "first part of the answer")).toBe(true);
    expect(previewMatchesSent(ring, "and the second")).toBe(true);
    expect(previewMatchesSent(ring, "a genuine reply")).toBe(false);
    expect(previewMatchesSent([], "anything")).toBe(false);
  });
});

describe("normalizeScrapedText", () => {
  it("removes invisible characters and rendered whitespace runs", () => {
    expect(normalizeScrapedText("\u202aWhat's today's weather\u202c")).toBe(
      "What's today's weather"
    );
    expect(normalizeScrapedText("zero\u200bwidth\u2060joined")).toBe(
      "zerowidthjoined"
    );
    expect(normalizeScrapedText("  spaced \t out  ")).toBe("spaced out");
    expect(normalizeScrapedText("plain")).toBe("plain");
  });
});
