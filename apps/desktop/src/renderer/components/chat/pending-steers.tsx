import { Pencil, X } from "lucide-react";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { MessageQueueEntry } from "#renderer/conversation/agent-types";

import { Button, Textarea } from "../ui";

/**
 * Messages sent mid-turn and not yet with the model. Until pi delivers one at
 * the agent's next step it is only queued text, so it can still be edited or
 * withdrawn here; a row leaves once the host reports it landed.
 */
export const PendingSteers = ({
  entries,
  onEdit,
  onRemove,
}: {
  entries: MessageQueueEntry[];
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const visible = entries.filter((entry) => entry.hidden !== true);

  if (visible.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1 px-3 pb-1"
      data-id="pending-steers"
      aria-live="polite"
    >
      {visible.map((entry) => (
        <PendingSteerRow
          key={entry.id}
          entry={entry}
          onEdit={(text) => onEdit(entry.id, text)}
          onRemove={() => onRemove(entry.id)}
          label={t(WAITING_LABEL[entry.waitingFor ?? "turn"])}
        />
      ))}
    </div>
  );
};

const WAITING_LABEL: Record<
  NonNullable<MessageQueueEntry["waitingFor"]>,
  string
> = {
  step: "workspace.pendingSteer.step",
  permission: "workspace.pendingSteer.permission",
  turn: "workspace.pendingSteer.turn",
};

const PendingSteerRow = ({
  entry,
  label,
  onEdit,
  onRemove,
}: {
  entry: MessageQueueEntry;
  label: string;
  onEdit: (text: string) => void;
  onRemove: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (next.length === 0) onRemove();
    else if (next !== entry.message) onEdit(next);
  };

  return (
    <div
      className="border-border bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs"
      data-id={`pending-steer-${entry.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[11px]" data-id="pending-steer-label">
          {label}
        </span>
        {draft == null ? (
          <span
            className="text-foreground line-clamp-2 whitespace-pre-wrap"
            data-id="pending-steer-text"
          >
            {entry.message}
          </span>
        ) : (
          <Textarea
            value={draft}
            autoFocus
            rows={2}
            className="text-foreground min-h-0"
            data-id="pending-steer-editor"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("workspace.pendingSteer.edit")}
          title={t("workspace.pendingSteer.edit")}
          data-id="pending-steer-edit"
          onClick={() => setDraft(entry.message)}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("workspace.pendingSteer.remove")}
          title={t("workspace.pendingSteer.remove")}
          data-id="pending-steer-remove"
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
    </div>
  );
};
