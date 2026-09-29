import { describe, expect, it } from "vitest";

import {
  BOT_REACTION_EMOJIS,
  buildBotReactionTool,
} from "./bot-reaction-tool.js";

describe("bot reactions", () => {
  it("returns a structured reaction that can be replayed from the transcript", async () => {
    for (const emoji of BOT_REACTION_EMOJIS) {
      const result = await buildBotReactionTool().execute("call", { emoji });
      expect(JSON.parse(result.content[0]!.text)).toEqual({ emoji });
      expect(result.isError).toBeUndefined();
    }
  });
  it("rejects unsupported emoji, prose, and missing values", async () => {
    for (const emoji of [undefined, null, 5, "", "Great job!", "👍👍"]) {
      expect(
        (await buildBotReactionTool().execute("call", { emoji })).isError
      ).toBe(true);
    }
  });
});
