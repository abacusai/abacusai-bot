import { ListTodo, X } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { TodoItem, TodoState } from "../../conversation";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

type TaskStatus = "pending" | "inProgress" | "completed";

interface ComposerTaskStep {
  id: string;
  label: string;
  status: TaskStatus;
}

interface ComposerTasksProgress {
  current: string;
  completed: number;
  total: number;
}

const taskStatus = (status: TodoItem["status"]): TaskStatus =>
  status === "in_progress" ? "inProgress" : status;

const taskSteps = (todos: TodoState): ComposerTaskStep[] =>
  todos.todos.map((todo) => ({
    id: todo.id,
    label: todo.content,
    status: taskStatus(todo.status),
  }));

const taskProgress = (todos: TodoState): ComposerTasksProgress => ({
  current:
    todos.todos.find((todo) => todo.status === "in_progress")?.content ??
    todos.todos.find((todo) => todo.status === "pending")?.content ??
    todos.todos.at(-1)?.content ??
    "",
  completed: todos.completed,
  total: todos.total,
});

const TaskSegments = ({ steps }: { steps: ComposerTaskStep[] }) => {
  if (steps.length <= 1) return null;

  return (
    <span aria-hidden className="flex w-20 shrink-0 items-center gap-0.5">
      {steps.map((step) => (
        <span
          key={step.id}
          className={cn(
            "h-0.75 min-w-0 flex-1 rounded-full",
            step.status === "completed"
              ? "bg-emerald-500"
              : step.status === "inProgress"
                ? "bg-primary"
                : "bg-muted-foreground/25"
          )}
        />
      ))}
    </span>
  );
};

interface ComposerTasksProps {
  todos: TodoState;
  expanded: boolean;
  onDismiss: () => void;
  onToggle: () => void;
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  todos,
  expanded,
  onDismiss,
  onToggle,
}: ComposerTasksProps) {
  const { t } = useTranslation();
  const progress = taskProgress(todos);
  const steps = taskSteps(todos);

  if (progress.total === 0) return null;

  return (
    <div
      className="border-border/80 bg-card/80 text-muted-foreground absolute -top-7 right-4 left-4 z-0 flex h-8 items-center gap-1 rounded-t-xl border border-b-0 px-2 pb-1 text-xs leading-none shadow-[0_-10px_24px_-22px_rgb(0_0_0/0.9)] backdrop-blur-xl"
      data-composer-tasks-badge="true"
    >
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-label={t("workspace.composerTasks.progressLabel", {
          completed: progress.completed,
          total: progress.total,
          current: progress.current,
        })}
        className="h-auto min-w-0 flex-1 justify-start self-stretch px-0 text-left font-normal"
        onClick={onToggle}
        onPointerDown={(event) => event.preventDefault()}
      >
        <ListTodo aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">{t("workspace.composerTasks.title")}</span>
        <span className="text-foreground/80 min-w-0 flex-1 truncate font-medium">
          {progress.current}
        </span>
        <span className="shrink-0 font-medium tabular-nums">
          {progress.completed}/{progress.total}
        </span>
        <TaskSegments steps={steps} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("workspace.composerTasks.dismiss")}
        onClick={onDismiss}
        onPointerDown={(event) => event.preventDefault()}
      >
        <X aria-hidden className="size-3" />
      </Button>
    </div>
  );
});

export const ComposerTasksDrawer = memo(function ComposerTasksDrawer({
  todos,
  onDismiss,
  onToggle,
}: ComposerTasksProps) {
  const { t } = useTranslation();
  const progress = taskProgress(todos);
  const steps = taskSteps(todos);

  return (
    <div
      className="border-border/80 bg-card/80 relative z-0 mx-auto -mb-4 w-[calc(100%-2rem)] rounded-t-xl border border-b-0 px-3 pt-1.5 pb-7 shadow-[0_-10px_24px_-22px_rgb(0_0_0/0.9)] backdrop-blur-xl sm:px-4"
      data-chat-composer-tasks-drawer="true"
    >
      <div className="flex items-center gap-1 py-1">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded="true"
          className="text-muted-foreground h-auto min-w-0 flex-1 justify-start self-stretch px-0 text-left font-normal"
          onClick={onToggle}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ListTodo aria-hidden className="size-3.5 shrink-0" />
          <span className="text-foreground font-medium">
            {t("workspace.composerTasks.title")}
          </span>
          <span className="tabular-nums">
            {progress.completed}/{progress.total}
          </span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("workspace.composerTasks.dismiss")}
          onClick={onDismiss}
          onPointerDown={(event) => event.preventDefault()}
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="space-y-px pb-1" role="list">
        {steps.map((step) => (
          <div
            key={step.id}
            className="flex items-baseline gap-2 text-xs leading-5"
            role="listitem"
          >
            <span
              aria-hidden
              className={cn(
                "w-3 shrink-0 text-center font-mono text-[0.625rem]",
                step.status === "completed"
                  ? "text-emerald-500"
                  : step.status === "inProgress"
                    ? "text-primary"
                    : "text-muted-foreground/40"
              )}
            >
              {step.status === "completed"
                ? "✓"
                : step.status === "inProgress"
                  ? "●"
                  : "○"}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1",
                step.status === "completed"
                  ? "text-muted-foreground/55"
                  : step.status === "inProgress"
                    ? "text-foreground/90"
                    : "text-muted-foreground/70"
              )}
            >
              {step.label}
            </span>
            <span className="text-muted-foreground/45 ml-auto w-10 shrink-0 text-right text-[0.625rem] tabular-nums">
              {step.status === "inProgress"
                ? t("workspace.composerTasks.now")
                : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
