/**
 * `suggest_tasks`: the tasks a bot's reply ends with, as buttons the user
 * taps instead of typing. A tap sends the button's own text as the user's
 * message (or, for a copy button, puts it on the clipboard), so what a
 * button says is exactly what it does: the text is one short plain line,
 * never a label over hidden words. Main checks a call with this and the
 * renderer draws it from the same reading, so the two never disagree.
 */

export const SUGGEST_TASKS_TOOL = "suggest_tasks";

/** A reply offers two or three: one is a question, four is a menu. */
export const SUGGESTED_TASKS_MAX = 3;

/** Long enough for "Research the best budget laptops and give me a one-page report". */
export const SUGGESTED_TASK_MAX_CHARS = 90;

export interface SuggestedTask {
  text: string;
  /** Copied for the user to send elsewhere (their phone), not sent here. */
  copy: boolean;
}

// Control characters and the bidi and zero-width marks that make what a
// button shows differ from what it sends.
const HIDDEN =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * The app's own notes to the agent ("[first run] ...", a system reminder):
 * a tap sends what the user could type, never words that read as the app's.
 */
const APP_NOTE = /^\[|<\/?system_reminder/i;

/** One task's text as a button shows it, or null when it cannot be one. */
const taskText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 &&
    text.length <= SUGGESTED_TASK_MAX_CHARS &&
    !APP_NOTE.test(text)
    ? text
    : null;
};

/**
 * The tasks a call offers, in its order: the well-formed ones, each text
 * once, at most `SUGGESTED_TASKS_MAX`. A task too long or empty is dropped
 * rather than cut, since a cut text is a different request.
 */
export const suggestedTasks = (input: unknown): SuggestedTask[] => {
  const raw =
    input != null && typeof input === "object" && !Array.isArray(input)
      ? (input as { tasks?: unknown }).tasks
      : undefined;
  if (!Array.isArray(raw)) return [];
  const out: SuggestedTask[] = [];
  for (const entry of raw) {
    const item =
      typeof entry === "string"
        ? { text: entry }
        : entry != null && typeof entry === "object"
          ? (entry as { text?: unknown; copy?: unknown })
          : null;
    const text = taskText(item?.text);
    if (text == null || out.some((task) => task.text === text)) continue;
    out.push({ text, copy: item?.copy === true });
    if (out.length === SUGGESTED_TASKS_MAX) break;
  }
  return out;
};
