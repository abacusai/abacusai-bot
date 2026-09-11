/**
 * Standing instructions the user writes once and the agent follows always.
 * Unlike MEMORY.md and USER.md, nothing in the agent writes this file: a model
 * that could edit its own instructions could edit them away. Re-read per turn
 * (refreshCustomInstructions in session.ts) so edits land on the next message.
 */
import fs from "fs";
import path from "path";

import { abacusBotDir } from "./config.js";

/** Bounded because this lands in every request; a page of house style fits. */
export const MAX_CUSTOM_INSTRUCTIONS = 8_000;

export function customInstructionsPath(): string {
  return path.join(abacusBotDir(), "INSTRUCTIONS.md");
}

/** What the user wrote, or "" for nothing set — never throws. */
export function readCustomInstructions(): string {
  try {
    return fs.readFileSync(customInstructionsPath(), "utf8").trim();
  } catch {
    // Missing or unreadable must never stop a session starting.
    return "";
  }
}

/** Replace them. Empty clears the file, so "none" is one state on disk. */
export function writeCustomInstructions(text: string): void {
  const trimmed = text.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS);

  fs.mkdirSync(abacusBotDir(), { recursive: true });

  if (trimmed.length === 0) {
    try {
      fs.rmSync(customInstructionsPath());
    } catch {
      // Already absent, which is the state being asked for.
    }

    return;
  }

  fs.writeFileSync(customInstructionsPath(), `${trimmed}\n`, "utf8");
}

/**
 * The block appended last to the system prompt, or null when nothing is set.
 * Framed rather than pasted raw so the model can tell instruction from context.
 * It cannot widen permissions (the gate decides), and saying so keeps the model
 * from reporting a refusal as the user's instruction failing.
 */
export function customInstructionsPrompt(): string | null {
  const text = readCustomInstructions();

  if (text.length === 0) return null;

  return [
    "The user's standing instructions, which they set for every conversation.",
    "Follow them. Where they disagree with the general guidance above about",
    "tone, format or how to approach work, these win. They do not grant access:",
    "approvals and the permission mode still decide what may actually run.",
    "",
    text,
  ].join("\n");
}
