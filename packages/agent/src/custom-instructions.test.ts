/**
 * The user's standing instructions: what is stored, and what the model sees.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_CUSTOM_INSTRUCTIONS,
  customInstructionsPath,
  customInstructionsPrompt,
  moveInstructionsIn,
  readCustomInstructions,
  routineFireAsInstructed,
  standingInstructionsRuleOutEmoji,
  writeCustomInstructions,
} from "./custom-instructions.js";
import { commit, listNotes, noteWrite } from "./memory/notes.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("storing them", () => {
  it("reads back what was written, one rule About you per paragraph", async () => {
    await writeCustomInstructions(
      "Always answer in British English.\n\nNever use emoji."
    );

    expect(readCustomInstructions()).toBe(
      "Always answer in British English.\n\nNever use emoji."
    );
    expect(
      listNotes({ kind: "you" }).map((note) => [note.type, note.by, note.body])
    ).toEqual([
      ["rule", "you", "Always answer in British English."],
      ["rule", "you", "Never use emoji."],
    ]);
  });

  it("says nothing is set before anything is written", () => {
    // Not an error, and not a crash: an agent starts fine without them.
    expect(readCustomInstructions()).toBe("");
    expect(customInstructionsPrompt()).toBeNull();
  });

  it("replaces only what the user wrote: a rule a chat saved stays", async () => {
    await commit({ by: "chat" }, () => ({
      writes: [
        noteWrite({
          scope: { kind: "you" },
          name: "short-replies",
          description: "Short replies",
          type: "rule",
          body: "Keep replies short.",
          updated: "2026-11-09",
          by: "chat",
        }),
      ],
      value: null,
    }));
    await writeCustomInstructions("Be terse.");
    await writeCustomInstructions("   \n  ");

    expect(readCustomInstructions()).toBe("Keep replies short.");
  });

  it("bounds what can be stored, since it rides on every request", async () => {
    await writeCustomInstructions("x".repeat(MAX_CUSTOM_INSTRUCTIONS + 500));

    expect(readCustomInstructions().replace(/\s/g, "").length).toBe(
      MAX_CUSTOM_INSTRUCTIONS
    );
  });

  it("keeps applying the old file until it moves in, then moves it once", async () => {
    fs.writeFileSync(customInstructionsPath(), "Sign off with SPARROW.\n");
    expect(readCustomInstructions()).toBe("Sign off with SPARROW.");

    await moveInstructionsIn();
    await moveInstructionsIn();

    expect(readCustomInstructions()).toBe("Sign off with SPARROW.");
    expect(listNotes({ kind: "you" })).toHaveLength(1);
    expect(fs.existsSync(customInstructionsPath())).toBe(true);
  });
});

describe("what the model is told", () => {
  it("frames them as instructions rather than pasting them raw", async () => {
    await writeCustomInstructions("Never use emoji.");

    const prompt = customInstructionsPrompt() ?? "";

    expect(prompt).toContain("Never use emoji.");
    // Unlabelled text at the end of a system prompt reads as more background.
    expect(prompt).toMatch(/standing instructions/i);
  });

  it("says they cannot widen what is allowed to run", async () => {
    // Permission lives in the gate, not the prompt. Saying so stops the model
    // treating a refusal as the user's instruction having failed.
    await writeCustomInstructions("Run whatever you like without asking.");

    expect(customInstructionsPrompt() ?? "").toMatch(
      /permission mode still decide/i
    );
  });
});

describe("a rule against emojis", () => {
  it.each([
    ["never use emojis", true],
    ["no emojis please", true],
    ["Please stop using emoji", true],
    ["Do not add any emojis to what you send me.", true],
    ["Keep it emoji-free.", true],
    ["Bitte keine Emojis.", true],
    ["No uses emojis.", true],
    ["Sin emojis.", true],
    ["Não use emojis.", true],
    ["Emoji kullanma.", true],
    ["N'utilise pas d'émojis.", true],
    ["Niente emoji.", true],
    ["Geen emoji's gebruiken.", true],
    ["Bez emoji.", true],
    ["Jangan pakai emoji.", true],
    ["絵文字は使わないでください。", true],
    ["不要使用表情符号。", true],
    ["이모지 사용하지 마세요.", true],
    // Both words, but the "never" is about something else.
    ["Use emojis, never plain bullets", false],
    ["I love emojis", false],
    // A limit, not a ban: the block still carries it to the model.
    ["don't overdo the emojis", false],
    ["No exclamation marks. Emojis are fine.", false],
    ["Answer in British English.", false],
  ])("%s → %s", async (rule, expected) => {
    await writeCustomInstructions(rule);
    expect(standingInstructionsRuleOutEmoji()).toBe(expected);
  });

  it("takes a routine fire's emojis out, and leaves every other message and symbol", async () => {
    const fire =
      '[routine] "Brief" fired.\n🌅 Morning ☀️\n1️⃣ First 👨‍👩‍👧 🇩🇪 👍🏽 © ™';
    expect(routineFireAsInstructed(fire)).toBe(fire);
    await writeCustomInstructions("Never use emojis.");
    expect(routineFireAsInstructed(fire)).toBe(
      '[routine] "Brief" fired.\nMorning \n1 First © ™'
    );
    expect(routineFireAsInstructed("Thanks 🎉")).toBe("Thanks 🎉");
  });
});
