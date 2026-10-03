import type { UIMessage } from "@tanstack/ai-client";
import { useTranslation } from "react-i18next";

import { Button } from "#next/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#next/ui/popover";
export interface SessionTask {
  content: string;
  status: string;
}
export const sessionTasks = (messages: readonly UIMessage[]): SessionTask[] => {
  for (const message of [...messages].reverse())
    for (const part of [...message.parts].reverse()) {
      if (
        part.type !== "tool-call" ||
        !["todo", "todo_write"].includes(part.name)
      )
        continue;
      try {
        const value =
          typeof part.arguments === "string"
            ? JSON.parse(part.arguments)
            : part.arguments;
        const tasks: unknown = value?.todos ?? value?.tasks;
        if (!Array.isArray(tasks)) continue;
        return tasks.filter(
          (t): t is SessionTask =>
            t != null &&
            typeof t.content === "string" &&
            typeof t.status === "string"
        );
      } catch {}
    }
  return [];
};
export const SessionTasks = ({
  messages,
}: {
  messages: readonly UIMessage[];
}) => {
  const { t } = useTranslation();
  const tasks = sessionTasks(messages);
  if (!tasks.length) return null;
  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
        {t("sessions.tray.tasks", {
          done: tasks.filter((task) => task.status === "completed").length,
          total: tasks.length,
        })}
      </PopoverTrigger>
      <PopoverContent>
        <ol>
          {tasks.map((task, i) => (
            <li key={i} className="flex gap-2 py-1">
              <span aria-hidden>
                {task.status === "completed"
                  ? "✓"
                  : task.status === "in_progress"
                    ? "◉"
                    : "○"}
              </span>
              <span>{task.content}</span>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
};
