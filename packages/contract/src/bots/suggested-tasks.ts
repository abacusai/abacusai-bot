/**
 * `suggest_tasks`: the tasks a bot's reply ends with, as buttons the user
 * taps instead of typing. A tap sends the button's own text as the user's
 * message (or, for a copy button, puts it on the clipboard), so what a
 * button says is exactly what it does: the text is one short plain line,
 * never a label over hidden words. A call can instead carry a short form
 * (`fields`) for what only the user knows, such as their name: its one task
 * is the submit button and heads the message it sends. Main checks a call
 * with this and the renderer draws it from the same reading, so the two
 * never disagree.
 */

export const SUGGEST_TASKS_TOOL = "suggest_tasks";

/** `suggest_tasks`, under its MCP server's prefix or bare. */
export const isSuggestTasksTool = (name: string): boolean =>
  name === SUGGEST_TASKS_TOOL || name.endsWith(`_${SUGGEST_TASKS_TOOL}`);

/** A reply offers two or three: one is a question, four is a menu. */
export const SUGGESTED_TASKS_MAX = 3;

/** Long enough for "Research the best budget laptops and give me a one-page report". */
export const SUGGESTED_TASK_MAX_CHARS = 90;

/** A form asks for two or three things at most: more is a questionnaire. */
export const SUGGESTED_FIELDS_MAX = 3;

/** Long enough for "What you do, in a few words". */
export const SUGGESTED_FIELD_LABEL_MAX_CHARS = 40;

/** Long enough for "Wedding photographer in Lisbon". */
export const SUGGESTED_FIELD_PLACEHOLDER_MAX_CHARS = 60;

export interface SuggestedTask {
  text: string;
  /** Copied for the user to send elsewhere (their phone), not sent here. */
  copy: boolean;
  /** Tapping it asks for a routine: the button shows a clock. */
  routine: boolean;
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

/** A model's line as the user sees it, or null when it cannot be shown. */
const shownLine = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= max && !APP_NOTE.test(text)
    ? text
    : null;
};

/** One task's text as a button shows it, or null when it cannot be one. */
const taskText = (value: unknown): string | null =>
  shownLine(value, SUGGESTED_TASK_MAX_CHARS);

/** The call is a next step under a result (next-step.ts), not a menu. */
export const suggestsNextStep = (input: unknown): boolean =>
  input != null &&
  typeof input === "object" &&
  (input as { after_result?: unknown }).after_result === true;

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
          ? (entry as { text?: unknown; copy?: unknown; routine?: unknown })
          : null;
    const text = taskText(item?.text);
    if (text == null || out.some((task) => task.text === text)) continue;
    out.push({
      text,
      copy: item?.copy === true,
      routine: item?.routine === true,
    });
    if (out.length === SUGGESTED_TASKS_MAX) break;
  }
  return out;
};

export interface SuggestedField {
  /** What to type, in the user's language: also the answer's label in the message. */
  label: string;
  /** An example shown inside the empty box. */
  placeholder: string | null;
}

/** A call's form: its one task, sent with what the user typed into the fields. */
export interface SuggestedForm {
  task: string;
  fields: SuggestedField[];
}

/**
 * The fields a call asks for, in its order: each label once, at most
 * `SUGGESTED_FIELDS_MAX`. A bad placeholder is dropped, not its field.
 */
export const suggestedFields = (input: unknown): SuggestedField[] => {
  const raw =
    input != null && typeof input === "object" && !Array.isArray(input)
      ? (input as { fields?: unknown }).fields
      : undefined;
  if (!Array.isArray(raw)) return [];
  const out: SuggestedField[] = [];
  for (const entry of raw) {
    const item =
      typeof entry === "string"
        ? { label: entry }
        : entry != null && typeof entry === "object"
          ? (entry as { label?: unknown; placeholder?: unknown })
          : null;
    const label = shownLine(item?.label, SUGGESTED_FIELD_LABEL_MAX_CHARS);
    if (label == null || out.some((field) => field.label === label)) continue;
    out.push({
      label,
      placeholder: shownLine(
        item?.placeholder,
        SUGGESTED_FIELD_PLACEHOLDER_MAX_CHARS
      ),
    });
    if (out.length === SUGGESTED_FIELDS_MAX) break;
  }
  return out;
};

/**
 * The form a call draws, or null when it is buttons: fields, and exactly one
 * task that sends (not a copy or a routine), since the form has one button.
 */
export const suggestedForm = (input: unknown): SuggestedForm | null => {
  const fields = suggestedFields(input);
  const tasks = suggestedTasks(input);
  const task = tasks[0];
  if (fields.length === 0 || tasks.length !== 1 || task == null) return null;
  if (task.copy || task.routine) return null;
  return { task: task.text, fields };
};

/**
 * The message a form sends: its task, then one "label: value" line per filled
 * field, in the model's own labels; null while every field is empty.
 */
export const suggestedFormMessage = (
  form: SuggestedForm,
  values: readonly string[]
): string | null => {
  const lines = form.fields.flatMap((field, index) => {
    const value = (values[index] ?? "").replace(/\s+/g, " ").trim();
    return value.length > 0 ? [`${field.label}: ${value}`] : [];
  });
  return lines.length > 0 ? [form.task, ...lines].join("\n") : null;
};
