import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { MigratedThreadFileV2Schema } from "./thread-file";
import { isHiddenUserText, legacyOperator, visibleUserText } from "./user-text";
import { v1ToUiMessages } from "./v1-to-ui-messages";

describe("operator user text", () => {
  it.each([
    "[first run] Introduce yourself",
    "[mission updated] New mission",
    '[routine] "Digest" fired',
  ])("hides legacy %s", (text) => {
    expect(isHiddenUserText(text)).toBe(true);
    expect(visibleUserText(text)).toBe("");
  });
  it("recognises only anchored known prefixes with their trailing space", () => {
    for (const text of [
      "I wrote [first run] hello",
      "[first run]",
      "[first runs] hello",
      " [mission updated] hi",
      "[memory flush] human quote",
    ]) {
      expect(legacyOperator(text)).toBeUndefined();
      expect(visibleUserText(text)).toBe(text.trim());
    }
  });
  it("projects old auto replies at the first blank line and preserves sender paragraphs", () => {
    const text = "[auto-reply] rules\n\n[Ada] hello\n\nsecond paragraph";
    expect(visibleUserText(text)).toBe("[Ada] hello\n\nsecond paragraph");
    expect(visibleUserText("[auto-reply] rules")).toBe("");
  });
  it("uses tagged UTF-16 offsets on raw text before stripping reminders", () => {
    const prefix = "operator 😀\n\n";
    const text = `${prefix}[Ada] hello\n\n<system_reminder>tools</system_reminder>`;
    expect(
      visibleUserText(text, {
        operator: { kind: "auto-reply-intro", visibleFrom: prefix.length },
      })
    ).toBe("[Ada] hello");
    expect(visibleUserText(text, { operator: { kind: "kickstart" } })).toBe("");
    expect(
      visibleUserText(text, {
        operator: { kind: "auto-reply-reminder", visibleFrom: text.length + 1 },
      })
    ).toBe("");
    expect(
      visibleUserText("hello\n\n<system_reminder>tools</system_reminder>", {
        operator: { kind: "environment-notice", visibleFrom: 0 },
      })
    ).toBe("hello");
  });
  it.each([
    "kickstart",
    "mission-updated",
    "auto-reply-intro",
    "auto-reply-reminder",
    "environment-notice",
    "routine-editor",
  ])("accepts migrated %s tags and rejects invalid offsets", (kind) => {
    const file = (visibleFrom?: number) => ({
      version: 3,
      threadId: "t",
      updatedAt: "x",
      source: { kind: "transcript-v1", updatedAt: "x", segments: 1 },
      messages: [
        {
          id: "u",
          role: "user",
          parts: [
            {
              type: "text",
              content: "prompt",
              metadata: { abacus: { segmentId: "u" } },
            },
          ],
          metadata: {
            abacus: {
              segments: [],
              userText: {
                operator: { kind, ...(visibleFrom != null && { visibleFrom }) },
              },
            },
          },
        },
      ],
    });
    expect(v.safeParse(MigratedThreadFileV2Schema, file()).success).toBe(true);
    expect(v.safeParse(MigratedThreadFileV2Schema, file(0)).success).toBe(true);
    expect(v.safeParse(MigratedThreadFileV2Schema, file(-1)).success).toBe(
      false
    );
    expect(v.safeParse(MigratedThreadFileV2Schema, file(1.5)).success).toBe(
      false
    );
  });
});

it("migrates legacy operator tags without changing transcript text", () => {
  const content = "[auto-reply] rules\n\n[Ada] hello";
  const messages = v1ToUiMessages([
    { id: "u", type: "text", source: "user", content },
  ]);
  expect(messages[0]?.metadata?.abacus?.userText).toMatchObject({
    operator: { kind: "auto-reply-intro", visibleFrom: 20 },
  });
  expect(messages[0]?.parts[0]).toMatchObject({ type: "text", content });
});
