import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { MigratedThreadFileV2Schema } from "./thread-file";
import {
  hasSystemReminder,
  isHiddenUserText,
  isPastedText,
  isRoutineFire,
  pastedTextKey,
  legacyOperator,
  visibleUserText,
} from "./user-text";
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

describe("system reminders", () => {
  const open = "<system_reminder>";
  const close = "</system_reminder>";
  it.each([
    ["", false, ""],
    ["hello", false, "hello"],
    [`hi ${open}x${close} there`, true, "hi  there"],
    [`${open}${close}`, true, ""],
    [`a${open}1${close}b${open}2${close}c`, true, "abc"],
    [`a${open}1${open}2${close}b${close}c`, true, `ab${close}c`],
    [`${open}multi\nline\t😀${close}\n\t é `, true, "é"],
    [`keep ${open}unclosed`, false, `keep ${open}unclosed`],
    [`${close} before ${open}`, false, `${close} before ${open}`],
    [`x${open}1${close}y${open}2`, true, `xy${open}2`],
    [open + close.slice(0, -1), false, open + close.slice(0, -1)],
    [" \n\t \u00a0", false, ""],
  ])("strips %j", (text, has, visible) => {
    expect(hasSystemReminder(text)).toBe(has);
    expect(visibleUserText(text)).toBe(visible);
  });
  it("sees a routine firing behind a reminder", () => {
    expect(isRoutineFire(`${open}x${close} [routine] "Digest"`)).toBe(true);
    expect(isRoutineFire(`${open}x [routine] "Digest"`)).toBe(false);
  });
  it("stays linear on many unclosed openers", () => {
    const text = open.repeat(100_000);
    const start = performance.now();
    expect(hasSystemReminder(text)).toBe(false);
    expect(isRoutineFire(text)).toBe(false);
    expect(visibleUserText(text)).toBe(text);
    expect(visibleUserText(`${text}${close}`)).toBe("");
    expect(performance.now() - start).toBeLessThan(1000);
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

describe("pasted-text files", () => {
  it.each([
    ["/w/.abacusai-bot/temp/pasted-text-att-1.txt", true],
    ["C:\\w\\.abacusai-bot\\temp\\pasted-text-note-0a1b2c3d4e5f6a7b.txt", true],
    // The hosted app's upload keeps the name behind a uuid.
    [
      "/vm/.abacusai-bot/temp/0f8fad5b-d9cb-469f-a165-70867728950e-pasted-text-note-1.txt",
      true,
    ],
    ["/w/notes.txt", false],
    ["/w/my-pasted-text-1.txt", false],
    ["/w/0f8fad5b-pasted-text-1.txt", false],
  ])("%s is pasted text: %s", (path, pasted) => {
    expect(isPastedText(path)).toBe(pasted);
  });

  it("names a note by its file's own name, whichever host saved it", () => {
    expect(
      pastedTextKey(
        "/vm/.abacusai-bot/temp/0f8fad5b-d9cb-469f-a165-70867728950e-pasted-text-note-1a2b.txt"
      )
    ).toBe("pasted-text-note-1a2b.txt");
    expect(pastedTextKey("C:\\w\\pasted-text-note-1a2b.txt")).toBe(
      "pasted-text-note-1a2b.txt"
    );
    expect(pastedTextKey("/w/notes.txt")).toBeNull();
  });
});
