/**
 * `RunningStrip`: what still runs past its turn, above the composer, for as
 * long as it runs: each background job by its label, how long it has run,
 * how far it says it has got (or its last line), "no output for…" when it
 * has gone quiet, and Stop. Served pages are listed the same way.
 */
import { Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { showError } from "#renderer/lib/toast";
import { Button } from "#renderer/ui/button";

import { useThreadStore } from "../store/selectors";
import type { BackgroundTask } from "../store/thread-store";
import { formatElapsed, useSeconds } from "./clock";
import { useChatView } from "./context";
import { ProgressMeter, QUIET_AFTER_MS } from "./tools/tool-line";

const TaskRow = ({ task, now }: { task: BackgroundTask; now: number }) => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const [stopping, setStopping] = useState(false);
  const title =
    task.kind === "serve"
      ? t("chat.tasks.serving", { url: task.command })
      : (task.label ?? task.command);
  const quietSince = task.lastOutputAt ?? task.startedAt;
  const quiet =
    task.kind === "job" &&
    quietSince != null &&
    now - quietSince >= QUIET_AFTER_MS;
  const stop = () => {
    setStopping(true);
    void session.stopTask(task.id).catch(() => {
      setStopping(false);
      showError(t("chat.tasks.stopFailed"));
    });
  };
  return (
    <li
      data-background-task={task.id}
      className="flex min-w-0 items-center gap-3 px-3 py-2"
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--chat-status-running)]"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm" title={task.command}>
          {title}
        </span>
        {task.progress == null && task.lastLine !== "" ? (
          <span className="text-muted-foreground chat-mono truncate text-xs">
            {task.lastLine}
          </span>
        ) : null}
      </span>
      <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
        {task.progress != null ? <ProgressMeter value={task.progress} /> : null}
        {quiet ? (
          <span data-task-quiet>
            {t("chat.tool.quiet", { time: formatElapsed(now - quietSince) })}
          </span>
        ) : null}
        {task.startedAt != null ? (
          <span className="tabular-nums">
            {formatElapsed(now - task.startedAt)}
          </span>
        ) : null}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={stopping}
        onClick={stop}
      >
        <Square aria-hidden className="size-3" />
        {t("chat.tasks.stop")}
      </Button>
    </li>
  );
};

export const RunningStrip = () => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const tasks = useThreadStore(session, (state) => state.backgroundTasks);
  const now = useSeconds(tasks.length > 0);
  if (tasks.length === 0) return null;
  return (
    <section
      aria-label={t("chat.tasks.title")}
      data-slot="running-strip"
      className="pointer-events-auto mx-4 overflow-hidden rounded-xl border bg-[var(--background)]"
    >
      <h2 className="text-muted-foreground px-3 pt-2 text-xs font-medium">
        {t("chat.tasks.title")}
      </h2>
      <ul className="divide-y">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} now={now} />
        ))}
      </ul>
    </section>
  );
};
