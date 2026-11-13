import { describe, expect, it } from "vitest";

import { NOTE_HOLD_CHARS, NoteGate, RunNotes } from "./repeated-notes.js";

const FIRST = "Checking both files to find where the date column comes from.";

/** One message through the gate: deltas in, what the user saw out. */
function stream(gate: NoteGate, deltas: string[], callsTool: boolean): string {
  gate.beginMessage();
  let shown = "";
  for (const delta of deltas) shown += gate.text(delta);
  if (callsTool) shown += gate.toolCall();
  return shown + gate.endMessage(deltas.join(""), callsTool);
}

describe("RunNotes", () => {
  it.each([
    [
      "the same note in other words",
      "Opening both files to find the date column.",
      true,
    ],
    [
      "a note in another script, restated",
      "دارم هر دو فایل را باز می‌کنم",
      false,
    ],
    [
      "a new finding",
      "Column D subtracts the wrong year; fixing the formula now.",
      false,
    ],
    ["one shared word only", "Checking the network.", false],
    [
      "the same step with a new number",
      "Checking both files: 710 rows where the date column comes from.",
      false,
    ],
    [
      "a note past the hold limit",
      `${FIRST} ${"more ".repeat(NOTE_HOLD_CHARS)}`,
      false,
    ],
  ])("%s", (_name, text, hidden) => {
    const notes = new RunNotes();
    notes.add(FIRST);
    expect(notes.hides(text)).toBe(hidden);
  });

  it("restates in any script", () => {
    const notes = new RunNotes();
    notes.add("دارم هر دو فایل را باز می‌کنم تا فرمول سررسید را پیدا کنم.");
    expect(
      notes.hides("دارم هر دو فایل را بررسی می‌کنم تا فرمول سررسید را پیدا کنم.")
    ).toBe(true);
  });

  it("hides nothing before the run's first note", () => {
    expect(new RunNotes().hides(FIRST)).toBe(false);
  });
});

describe("NoteGate", () => {
  it("streams the run's first note as it comes", () => {
    const gate = new NoteGate();
    gate.beginRun();
    gate.beginMessage();
    expect(gate.text("Checking ")).toBe("Checking ");
  });

  it("shows a new note at its tool call and drops a restated one", () => {
    const gate = new NoteGate();
    gate.beginRun();
    expect(
      stream(gate, ["Checking both files ", "to find the date column."], true)
    ).toBe("Checking both files to find the date column.");
    expect(
      stream(gate, ["Opening both files ", "to find the date column."], true)
    ).toBe("");
    expect(
      stream(gate, ["Found it: column D ", "uses the wrong year."], true)
    ).toBe("Found it: column D uses the wrong year.");
  });

  it("shows a reply after notes in full, even one that restates them", () => {
    const gate = new NoteGate();
    gate.beginRun();
    stream(gate, [FIRST], true);
    expect(stream(gate, [FIRST], false)).toBe(FIRST);
  });

  it("lets long text stream once it outgrows the hold", () => {
    const gate = new NoteGate();
    gate.beginRun();
    stream(gate, [FIRST], true);
    gate.beginMessage();
    const long = "x".repeat(NOTE_HOLD_CHARS + 1);
    expect(gate.text(long)).toBe(long);
    expect(gate.text("more")).toBe("more");
    expect(gate.toolCall()).toBe("");
  });

  it("forgets the notes of the last run", () => {
    const gate = new NoteGate();
    gate.beginRun();
    stream(gate, [FIRST], true);
    gate.beginRun();
    expect(stream(gate, [FIRST], true)).toBe(FIRST);
  });

  it("judges a message that arrives whole, with no deltas", () => {
    const gate = new NoteGate();
    gate.beginRun();
    stream(gate, [FIRST], true);
    gate.beginMessage();
    expect(gate.text(FIRST) + gate.endMessage(FIRST, true)).toBe("");
  });
});
