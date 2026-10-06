import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import {
  botThreadView,
  botVisibleMessage,
} from "#renderer/lib/bot-turns/turns";
import { hiddenUserMessage, userMessageText } from "#renderer/lib/user-message";

import { userView } from "./message";

const user = (content: string, userText?: UserTextTags): UIMessage => ({
  id: "u",
  role: "user",
  parts: [{ type: "text", content }],
  ...(userText != null && { metadata: { abacus: { userText } } }),
});

describe("operator bubbles and previews", () => {
  it.each(["kickstart", "mission-updated"] as const)(
    "hides tagged %s without relying on the text",
    (kind) => {
      const message = user("operator instructions", { operator: { kind } });
      expect(userView(message)).toEqual({ hidden: true, body: "", paths: [] });
      expect(botThreadView([message], false)[0]?.hidden).toBe(true);
      expect(botVisibleMessage(message, [message], false).parts).toEqual([]);
      expect(hiddenUserMessage(message)).toBe(true);
      expect(userMessageText(message)).toBe("");
    }
  );
  it.each(["auto-reply-intro", "auto-reply-reminder"] as const)(
    "shows only sender text for %s",
    (kind) => {
      const prefix = "rules 😀\n\n";
      const message = user(`${prefix}[Ada] hello\n\nsecond paragraph`, {
        operator: { kind, visibleFrom: prefix.length },
      });
      expect(userView(message)).toEqual({
        hidden: false,
        body: "[Ada] hello\n\nsecond paragraph",
        paths: [],
      });
      const projected = botVisibleMessage(message, [message], false);
      expect(userView(projected).body).toBe("[Ada] hello\n\nsecond paragraph");
      // BotMessage re-enters with the projected message. It must settle.
      expect(botVisibleMessage(projected, [message], false)).toBe(projected);
    }
  );
  it("cleans legacy bubbles, environment notices and routine fires", () => {
    expect(userView(user("[first run] Introduce yourself")).hidden).toBe(true);
    expect(userView(user("[mission updated] New mission")).hidden).toBe(true);
    expect(userView(user("[auto-reply] rules\n\n[Ada] hello")).body).toBe(
      "[Ada] hello"
    );
    expect(
      userView(
        user("hello\n\n<system_reminder>tools</system_reminder>", {
          operator: { kind: "environment-notice", visibleFrom: 0 },
        })
      ).body
    ).toBe("hello");
    expect(userView(user('[routine] "Digest" fired')).hidden).toBe(true);
    expect(userView(user("I typed [first run] myself")).body).toBe(
      "I typed [first run] myself"
    );
  });
});
