/**
 * Standing instructions: the rule notes About you (memory/you/), which every
 * chat follows, Memory on or off. The user adds and edits them on the Memory
 * page; a chat may save one when the user asks, but never changes one the user
 * wrote (memory/tool.ts), so a model cannot edit the user's instructions away.
 * Re-read per turn (refreshCustomInstructions in session.ts) so edits land on
 * the next message.
 */
import fs from "fs";
import path from "path";

import { abacusBotDir } from "./config.js";
import { MAX_NOTE_CHARS } from "./memory/gate.js";
import {
  commit,
  type FileWrite,
  listNotes,
  memoryDir,
  type Note,
  noteDelete,
  noteWrite,
  slugify,
  today,
} from "./memory/notes.js";

/** Bounded because this lands in every request; a page of house style fits. */
export const MAX_CUSTOM_INSTRUCTIONS = 8_000;

const MOVED_MARKER = ".migrated-instructions";

/** The file the instructions lived in before they were rule notes. */
export function customInstructionsPath(): string {
  return path.join(abacusBotDir(), "INSTRUCTIONS.md");
}

const legacyText = (): string => {
  if (fs.existsSync(path.join(memoryDir(), MOVED_MARKER))) return "";
  try {
    return fs.readFileSync(customInstructionsPath(), "utf8").trim();
  } catch {
    return "";
  }
};

const rules = (): Note[] =>
  listNotes({ kind: "you" }).filter((note) => note.type === "rule");

/** Every instruction, one per paragraph, or "" for none. Never throws. */
export function readCustomInstructions(): string {
  try {
    const text = rules()
      .map((note) => note.body.trim())
      .join("\n\n");
    // Until the old file has moved in (the desktop does it at start), it still applies.
    return [legacyText(), text].filter((part) => part.length > 0).join("\n\n");
  } catch {
    // Missing or unreadable must never stop a session starting.
    return "";
  }
}

/** Text cut into notes: one per paragraph, none longer than a note holds. */
const paragraphs = (text: string): string[] =>
  text
    .trim()
    .slice(0, MAX_CUSTOM_INSTRUCTIONS)
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      const pieces: string[] = [];
      for (let at = 0; at < part.length; at += MAX_NOTE_CHARS)
        pieces.push(part.slice(at, at + MAX_NOTE_CHARS));
      return pieces;
    });

const ruleNotes = (text: string, taken: Set<string>, now: Date): Note[] =>
  paragraphs(text).map((body) => {
    const base = slugify(
      body.split(/\s+/).slice(0, 6).join(" "),
      "instruction"
    );
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
    taken.add(name);
    return {
      scope: { kind: "you" },
      name,
      description: (body.split("\n")[0] ?? body).slice(0, 150),
      type: "rule",
      body,
      updated: today(now),
      by: "you",
    };
  });

/**
 * Replace the instructions the user wrote with `text`, one rule per
 * paragraph; rules a chat saved stay. Empty clears the user's own.
 */
export async function writeCustomInstructions(
  text: string,
  now = new Date()
): Promise<void> {
  const result = await commit({ by: "you" }, () => {
    const all = listNotes({ kind: "you" });
    const own = all.filter((note) => note.type === "rule" && note.by === "you");
    const taken = new Set(
      all.filter((note) => !own.includes(note)).map((note) => note.name)
    );
    const writes: FileWrite[] = [
      ...own.map((note) => noteDelete(note.scope, note.name)),
      ...ruleNotes(text, taken, now).map(noteWrite),
    ];
    return { writes, value: null };
  });
  if (!result.ok) throw new Error(result.message);
}

/**
 * The old instructions file, moved into rule notes once (a marker records it).
 * The file is left where it was.
 */
export async function moveInstructionsIn(now = new Date()): Promise<void> {
  if (fs.existsSync(path.join(memoryDir(), MOVED_MARKER))) return;
  await commit({ by: "app" }, () => {
    const marker = path.join(memoryDir(), MOVED_MARKER);
    if (fs.existsSync(marker)) return { writes: [], value: null };
    const text = legacyText();
    const taken = new Set(listNotes({ kind: "you" }).map((note) => note.name));
    return {
      writes: [
        ...ruleNotes(text, taken, now).map(noteWrite),
        { file: marker, contents: now.toISOString() },
      ],
      value: null,
    };
  });
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
