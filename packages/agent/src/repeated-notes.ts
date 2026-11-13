/**
 * A note is the text a model writes in the same message as a tool call. Asked
 * to keep the user posted, some models restate the same line before nearly
 * every call ("checking both files to find the date column" five times in a
 * minute). The user sees the first one; a later note in the same run that only
 * restates an earlier one is not shown. The model still has every note it
 * wrote in its context, so only the display changes.
 */

/** Words shorter than this carry no content ("the", "and", "now"). */
const NOTE_WORD_MIN_CHARS = 4;
/**
 * A note restates an earlier one when at least this share of its own words
 * (and at least NOTE_RESTATE_MIN_WORDS of them) are in it, and it names no
 * number the earlier one did not: "710 assets" or "3.2 GB" is a result.
 * Measured on real runs against a model judging "anything new?", this hides
 * about half the restatements and is right about as often as two strong
 * judges agree with each other.
 */
const NOTE_RESTATE_SHARE = 0.5;
const NOTE_RESTATE_MIN_WORDS = 2;
/**
 * Text held back until its message shows whether it is a note. Most notes are
 * one line; past this the text is shown and no longer judged, so a reply that
 * follows earlier notes reaches the screen this many characters late at most.
 */
export const NOTE_HOLD_CHARS = 300;

const WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const NUMBER = /\p{N}+/gu;

interface Note {
  words: Set<string>;
  numbers: Set<string>;
}

function readNote(text: string): Note {
  const lower = text.toLowerCase();
  const words = new Set<string>();
  for (const [word] of lower.matchAll(WORD))
    if ([...word].length >= NOTE_WORD_MIN_CHARS) words.add(word);
  return { words, numbers: new Set(lower.match(NUMBER) ?? []) };
}

function restates(note: Note, earlier: Note): boolean {
  for (const number of note.numbers)
    if (!earlier.numbers.has(number)) return false;
  let shared = 0;
  for (const word of note.words) if (earlier.words.has(word)) shared++;
  return (
    shared >= NOTE_RESTATE_MIN_WORDS &&
    shared / note.words.size >= NOTE_RESTATE_SHARE
  );
}

/** The notes of one run, and whether a new one would be hidden. */
export class RunNotes {
  private notes: Note[] = [];

  reset(): void {
    this.notes = [];
  }

  get any(): boolean {
    return this.notes.length > 0;
  }

  /** Whether `text`, written before a tool call, only restates an earlier note of this run. */
  hides(text: string): boolean {
    if (text.length > NOTE_HOLD_CHARS) return false;
    const note = readNote(text);
    return this.notes.some((earlier) => restates(note, earlier));
  }

  add(text: string): void {
    if (text.trim().length > 0) this.notes.push(readNote(text));
  }
}

/**
 * The display side: holds a message's text until a tool call shows it is a
 * note, then shows it or drops it. A message with no earlier note in its run,
 * or one whose text outgrows NOTE_HOLD_CHARS, streams as before.
 */
export class NoteGate {
  private readonly notes = new RunNotes();
  private held = "";
  private holding = false;
  private dropping = false;

  beginRun(): void {
    this.notes.reset();
    this.beginMessage();
  }

  beginMessage(): void {
    this.held = "";
    this.holding = this.notes.any;
    this.dropping = false;
  }

  /** Streamed text in; the text to show now out. */
  text(delta: string): string {
    if (this.dropping) return "";
    if (!this.holding) return delta;
    this.held += delta;
    if (this.held.length <= NOTE_HOLD_CHARS) return "";
    return this.release();
  }

  /** The message calls a tool: what was held is a note. */
  toolCall(): string {
    if (!this.holding) return "";
    if (!this.notes.hides(this.held)) return this.release();
    this.holding = false;
    this.dropping = true;
    this.held = "";
    return "";
  }

  /** The message ended with `text` in full: the held text to show, and its note recorded. */
  endMessage(text: string, calledTool: boolean): string {
    const shown = calledTool ? this.toolCall() : this.release();
    if (calledTool) this.notes.add(text);
    return shown;
  }

  private release(): string {
    const held = this.held;
    this.held = "";
    this.holding = false;
    return held;
  }
}
