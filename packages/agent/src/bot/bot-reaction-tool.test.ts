import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCustomInstructions } from "../custom-instructions.js";
import {
  BOT_REACTION_EMOJIS,
  buildBotReactionTool,
} from "./bot-reaction-tool.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "reactions-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

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
  it("fails, so nothing applies it, when the user's standing instructions rule out emojis", async () => {
    await writeCustomInstructions("Keine Emojis, bitte.");
    await expect(
      buildBotReactionTool().execute("call", { emoji: "🎉" })
    ).rejects.toThrow(/standing instructions rule out emojis/);
  });
});
