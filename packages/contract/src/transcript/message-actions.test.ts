import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { applyMessageReaction } from "../message-reactions";
import {
  parseThreadTwin,
  UIMessageSchema,
  v1ToThreadFile,
} from "./thread-file";
import { visibleUserText, isHiddenUserText } from "./user-text";

it("migrates v2 reactions and preserves reply metadata through a schema round trip", () => {
  const original = {
    version: 2,
    threadId: "t",
    updatedAt: "today",
    source: { kind: "agui" },
    messages: [
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "text", content: "hello" }],
        reactions: ["👍"],
      },
    ],
  };
  const parsed = parseThreadTwin(JSON.stringify(original));
  expect(parsed.status).toBe("ok");
  if (parsed.status !== "ok") throw new Error("migration failed");
  expect(parsed.file.version).toBe(3);
  expect(parsed.file.messages[0]?.metadata?.abacus?.reactions).toEqual(["👍"]);
  expect(parseThreadTwin(JSON.stringify(parsed.file))).toEqual(parsed);
  expect(v.safeParse(UIMessageSchema, parsed.file.messages[0]).success).toBe(
    true
  );
});

it("maps transcript reactions to UI metadata and toggles idempotently", () => {
  const file = v1ToThreadFile({
    threadId: "t",
    updatedAt: "now",
    segments: [
      {
        id: "a",
        type: "text",
        source: "bot",
        content: "hello",
        reactions: ["👍"],
      },
    ],
  });
  expect(file.messages[0]?.metadata?.abacus?.reactions).toEqual(["👍"]);
  const change = { messageId: "a", emoji: "❤️", selected: true };
  const once = applyMessageReaction(file.messages, change);
  expect(applyMessageReaction(once, change)).toEqual(once);
  expect(
    applyMessageReaction(once, { ...change, selected: false })[0]?.metadata
      ?.abacus?.reactions
  ).toEqual(["👍"]);
});

describe("reply and operator display", () => {
  it("hides reaction notifications and shows only the user's own reply text", () => {
    expect(
      isHiddenUserText("[reaction] The user reacted 👍", {
        operator: { kind: "user-reaction" },
      })
    ).toBe(true);
    const prefix = "> Assistant:\n> hello\n\n";
    const replyTo = {
      messageId: "a",
      role: "assistant" as const,
      excerpt: "hello",
    };
    expect(
      visibleUserText(prefix + "thanks", {
        replyTo,
        visibleFrom: prefix.length,
      })
    ).toBe("thanks");
  });
});
