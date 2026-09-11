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
  readCustomInstructions,
  writeCustomInstructions,
} from "./custom-instructions.js";

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
  it("reads back what was written", () => {
    writeCustomInstructions("Always answer in British English.");

    expect(readCustomInstructions()).toBe("Always answer in British English.");
  });

  it("says nothing is set before anything is written", () => {
    // Not an error, and not a crash: an agent starts fine without them.
    expect(readCustomInstructions()).toBe("");
    expect(customInstructionsPrompt()).toBeNull();
  });

  it("survives a directory that does not exist yet", () => {
    fs.rmSync(home, { recursive: true, force: true });

    writeCustomInstructions("Be terse.");

    expect(readCustomInstructions()).toBe("Be terse.");
  });

  it("treats blank as clearing, so there is one empty state and not two", () => {
    writeCustomInstructions("Be terse.");
    writeCustomInstructions("   \n  ");

    expect(readCustomInstructions()).toBe("");
    expect(fs.existsSync(customInstructionsPath())).toBe(false);
  });

  it("bounds what can be stored, since it rides on every request", () => {
    writeCustomInstructions("x".repeat(MAX_CUSTOM_INSTRUCTIONS + 500));

    expect(readCustomInstructions().length).toBe(MAX_CUSTOM_INSTRUCTIONS);
  });

  it("reads an unreadable file as nothing rather than throwing", () => {
    fs.mkdirSync(home, { recursive: true });
    // A directory where the file should be: readFileSync throws EISDIR.
    fs.mkdirSync(customInstructionsPath(), { recursive: true });

    expect(readCustomInstructions()).toBe("");
  });
});

describe("what the model is told", () => {
  it("frames them as instructions rather than pasting them raw", () => {
    writeCustomInstructions("Never use emoji.");

    const prompt = customInstructionsPrompt() ?? "";

    expect(prompt).toContain("Never use emoji.");
    // Unlabelled text at the end of a system prompt reads as more background.
    expect(prompt).toMatch(/standing instructions/i);
  });

  it("says they cannot widen what is allowed to run", () => {
    // Permission lives in the gate, not the prompt. Saying so stops the model
    // treating a refusal as the user's instruction having failed.
    writeCustomInstructions("Run whatever you like without asking.");

    expect(customInstructionsPrompt() ?? "").toMatch(
      /permission mode still decide/i
    );
  });
});
