/**
 * The agent's plan for the task in front of it. A copy of the desktop's
 * agent-tools/todo-store.ts (this package cannot reach the app's tree);
 * behaviour must stay identical and the tests pin it. Whole-list writes, not
 * per-item edits: the model restates a short plan well and tracks item ids
 * badly. In-memory only; a plan is scaffolding, not a record.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const VALID_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

let items: TodoItem[] = [];

export const readTodos = (): TodoItem[] => items;

export const setTodos = (
  next: unknown
): { ok: boolean; message: string; items: TodoItem[] } => {
  if (!Array.isArray(next)) {
    return { ok: false, message: "todos must be an array.", items };
  }

  const parsed: TodoItem[] = [];

  for (const entry of next) {
    const record = entry as Record<string, unknown>;
    const content =
      typeof record?.content === "string" ? record.content.trim() : "";
    const status = record?.status;

    if (content.length === 0) {
      return {
        ok: false,
        message: "Every todo needs non-empty content.",
        items,
      };
    }

    if (
      typeof status !== "string" ||
      !VALID_STATUSES.includes(status as TodoStatus)
    ) {
      return {
        ok: false,
        message: `"${content}" has an invalid status. Use one of: ${VALID_STATUSES.join(", ")}.`,
        items,
      };
    }

    parsed.push({ content, status: status as TodoStatus });
  }

  // More than one in-progress item means the plan has stopped describing what
  // is actually happening, which is the only thing it is for.
  const active = parsed.filter((item) => item.status === "in_progress");

  if (active.length > 1) {
    return {
      ok: false,
      message: "Only one todo can be in_progress at a time.",
      items,
    };
  }

  items = parsed;

  return { ok: true, message: "Plan updated.", items };
};

export const renderTodos = (list: TodoItem[]): string => {
  if (list.length === 0) return "The plan is empty.";

  const mark: Record<TodoStatus, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
  };

  return list.map((item) => `${mark[item.status]} ${item.content}`).join("\n");
};
