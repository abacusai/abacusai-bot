/**
 * `QueueSlot` (spec 02 §8.5): the agent's host queue above the composer,
 * one 40 px row per entry, Edit and Remove by incarnation + entry id, the
 * per-command state from the stream (pending, rejected, no answer), and
 * "{n} more waiting" past three rows.
 */
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMotionPreference } from "#next/lib/motion";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";
import { Spinner } from "#next/ui/spinner";

import { queueRow } from "../motion";
import { useThreadStore } from "../store/selectors";
import type { QueueCommandState, QueueEntry } from "../store/thread-store";
import { useChatView } from "./context";

const HINT_KEYS: Record<QueueEntry["waitingFor"], string> = {
  step: "chat.queue.waiting.step",
  permission: "chat.queue.waiting.permission",
  turn: "chat.queue.waiting.turn",
};

const PROBLEM_MS = 5000;

const problemKey = (command: QueueCommandState | undefined): string | null => {
  if (command == null) return null;
  if (command.state === "timeout") return "chat.queue.problem.noAnswer";
  if (command.state === "rejected")
    return command.reason === "incarnation"
      ? "chat.queue.problem.restarted"
      : "chat.queue.problem.wentOut";
  return null;
};

const QueueRow = ({
  entry,
  command,
  editing,
  onEdit,
}: {
  entry: QueueEntry;
  command: QueueCommandState | undefined;
  editing: boolean;
  onEdit(open: boolean): void;
}) => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const [draft, setDraft] = useState(entry.message);
  const pending = command?.state === "pending";
  const problem = problemKey(command);
  useEffect(() => {
    if (problem == null) return;
    const timer = setTimeout(
      () => session.clearQueueCommand(entry.id),
      PROBLEM_MS
    );
    return () => clearTimeout(timer);
  }, [problem, session, entry.id]);
  return (
    <div
      className="flex h-10 items-center gap-2 rounded-xl bg-[var(--chat-surface-2)] ps-3.5 pe-2 text-[13px]"
      data-slot="queue-row"
      data-entry={entry.id}
    >
      {editing ? (
        <Input
          autoFocus
          value={draft}
          aria-label={t("chat.queue.editLabel")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (draft.trim() !== "" && draft !== entry.message)
                void session.updateQueued(entry.id, draft);
              onEdit(false);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(entry.message);
              onEdit(false);
            }
          }}
          className="h-7 flex-1"
        />
      ) : (
        <div className="min-w-0 flex-1 truncate">{entry.message}</div>
      )}
      {problem != null ? (
        <span role="status" className="text-destructive shrink-0">
          {t(problem)}
        </span>
      ) : (
        <span className="text-muted-foreground shrink-0">
          {t(HINT_KEYS[entry.waitingFor])}
        </span>
      )}
      {pending ? <Spinner aria-hidden /> : null}
      {editing ? null : (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => onEdit(true)}
        >
          {t("chat.queue.edit")}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        disabled={pending}
        aria-label={t("chat.queue.remove")}
        onClick={() => void session.removeQueued(entry.id)}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
};

/** Rows of entries the stream removed while a rejection is still shown. */
const ghostRows = (
  queue: readonly QueueEntry[],
  commands: Record<string, QueueCommandState>
): QueueEntry[] =>
  Object.entries(commands)
    .filter(
      ([id, command]) =>
        command.state !== "pending" && !queue.some((entry) => entry.id === id)
    )
    .map(([id, command]) => ({
      id,
      message: command.text ?? "",
      waitingFor: "step",
    }));

export const QueueSlot = ({
  editingId,
  onEditingChange,
}: {
  editingId: string | null;
  onEditingChange(id: string | null): void;
}) => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const queue = useThreadStore(session, (state) => state.queue);
  const commands = useThreadStore(session, (state) => state.queueCommands);
  const [expanded, setExpanded] = useState(false);
  const pref = useMotionPreference();
  const rows = [...queue, ...ghostRows(queue, commands)];
  if (rows.length === 0) return null;
  const shown = expanded || rows.length <= 3 ? rows : rows.slice(0, 3);
  const transition = queueRow(pref);
  return (
    <div
      className="flex flex-col gap-1.5 px-4"
      data-slot="queue-slot"
      aria-label={t("chat.queue.label")}
      role="list"
    >
      <AnimatePresence initial={false}>
        {shown.map((entry) => (
          <motion.div
            key={entry.id}
            role="listitem"
            layout={pref === "full"}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition}
          >
            <QueueRow
              entry={entry}
              command={commands[entry.id]}
              editing={editingId === entry.id}
              onEdit={(open) => onEditingChange(open ? entry.id : null)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {rows.length > 3 ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t("chat.queue.fewer")
            : t("chat.queue.more", { count: rows.length - 3 })}
        </Button>
      ) : null}
    </div>
  );
};
