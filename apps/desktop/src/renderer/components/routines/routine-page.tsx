import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClock,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { BotSenderChat, RoutineRunItem } from "#shared/contracts";
import type { MessagingPairingDecisionRequest } from "#shared/messaging";

import { useBotSenderChatsQuery, useBotsQuery } from "../../hooks/use-bots";
import {
  useRemoveRoutineMutation,
  useRoutineRunsQuery,
  useRoutinesQuery,
  useRunRoutineMutation,
  useUpdateRoutineMutation,
} from "../../hooks/use-routines";
import { useWorkspaceMetadataQuery } from "../../hooks/use-workspace-queries";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { useWorkspaceStore } from "../../stores/code-store";
import { ChatPanel } from "../chat/chat-panel";
import { Dialog } from "../common/dialog";
import {
  describeSchedule,
  RoutineDialog,
  workspaceName,
} from "../settings/routines-panel";
import { Button, Input } from "../ui";
import { Badge } from "../ui/badge";
import { RoutineRunsRail } from "./routine-runs-rail";
import { autoReplySessionId } from "./routines-tree";

/**
 * A routine's page: the selected run's session read-only in the pane (a fire's
 * transcript is a report, not a conversation), the list of fires in the rail.
 * For an auto-reply chat the "run" is the conversation with that sender.
 */
export const RoutinePage = ({
  routineId,
}: {
  routineId: string;
}): JSX.Element => {
  const chatSessionId = autoReplySessionId(routineId);
  return chatSessionId != null ? (
    <AutoReplyPage sessionId={chatSessionId} />
  ) : (
    <ScheduledRoutinePage routineId={routineId} />
  );
};

/** Put a run's session on screen, the way clicking a session does. */
const useShowSession = (
  workspaceId: string | null,
  sessionId: string | null
): void => {
  useEffect(() => {
    if (workspaceId == null || sessionId == null) return;
    const store = useWorkspaceStore.getState();
    const previous = store.activeWorkspaceId;
    store.activateWorkspaceSession(workspaceId, sessionId);
    store.markSessionViewed(sessionId);
    if (previous !== workspaceId)
      void window.api.agent.switchWorkspace(workspaceId);
  }, [workspaceId, sessionId]);
};

const ScheduledRoutinePage = ({
  routineId,
}: {
  routineId: string;
}): JSX.Element => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const routinesQuery = useRoutinesQuery();
  const metadataQuery = useWorkspaceMetadataQuery();
  const routine =
    routinesQuery.data?.find((entry) => entry.id === routineId) ?? null;
  const runsQuery = useRoutineRunsQuery(routine?.id ?? null);
  const runs = runsQuery.data ?? [];
  const runMutation = useRunRoutineMutation();
  const updateMutation = useUpdateRoutineMutation();
  const removeMutation = useRemoveRoutineMutation();

  // The newest run until the user picks one; a pick that has since been
  // deleted falls back to the newest again rather than to nothing.
  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null);
  const selected: RoutineRunItem | null = useMemo(
    () =>
      runs.find((run) => run.sessionId === pickedSessionId) ?? runs[0] ?? null,
    [runs, pickedSessionId]
  );
  useShowSession(selected?.workspaceId ?? null, selected?.sessionId ?? null);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (routine == null) {
    return (
      <div
        className="text-muted-foreground flex h-full items-center justify-center text-sm"
        data-id="routine-page-missing"
      >
        {routinesQuery.isPending ? "" : t("routines.pageMissing")}
      </div>
    );
  }

  const madeBy =
    routine.botName != null
      ? ` · ${t("routines.madeBy", { bot: routine.botName })}`
      : "";

  // Named only when it is a project: "its own folder" is the default and
  // saying so on every routine would be noise. A routine whose instruction
  // reads a repository is the one where this line matters.
  const project = (metadataQuery.data?.workspaces ?? []).find(
    (workspace) =>
      workspace.id === routine.workspaceId && workspace.kind !== "routine"
  );
  const runsIn =
    project == null
      ? ""
      : ` · ${t("routines.runsIn", { folder: workspaceName(project, t) })}`;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-id={`routine-page-${routine.id}`}
    >
      <header className="border-border flex items-center gap-3 border-b px-4 py-2">
        <CalendarClock className="text-muted-foreground size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate text-sm font-medium"
            data-id="routine-page-name"
          >
            {routine.name}
          </span>
          <span
            className="text-muted-foreground truncate text-xs"
            data-id="routine-page-schedule"
          >
            {describeSchedule(
              routine.schedule,
              routine.runAt,
              t,
              i18n.language
            )}
            {madeBy}
            {runsIn}
          </span>
        </div>
        {!routine.enabled && (
          <Badge variant="outline">{t("routines.statPaused")}</Badge>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("routines.runNow")}
          title={t("routines.runNow")}
          data-id="routine-page-run"
          onClick={() =>
            void runMutation
              .mutateAsync(routine.id)
              .then(() =>
                toast.success(t("routines.ranNow"), { id: "routine-run" })
              )
              .catch(() =>
                toast.error(t("routines.runError"), { id: "routine-run" })
              )
          }
        >
          <Play />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            routine.enabled ? t("routines.pause") : t("routines.resume")
          }
          title={routine.enabled ? t("routines.pause") : t("routines.resume")}
          data-id="routine-page-toggle"
          onClick={() =>
            void updateMutation
              .mutateAsync({
                id: routine.id,
                changes: { enabled: !routine.enabled },
              })
              .catch(() =>
                toast.error(t("routines.updateError"), {
                  id: "routine-update",
                })
              )
          }
        >
          {routine.enabled ? <Pause /> : <Play className="opacity-60" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("routines.edit")}
          title={t("routines.edit")}
          data-id="routine-page-edit"
          onClick={() => setEditOpen(true)}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("routines.delete")}
          title={t("routines.delete")}
          data-id="routine-page-delete"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {selected != null ? (
            <ChatPanel />
          ) : (
            <div
              className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-sm"
              data-id="routine-page-empty"
            >
              <p>{t("routines.noRunsYet")}</p>
              <p className="max-w-md text-xs whitespace-pre-wrap">
                {routine.prompt}
              </p>
              {routine.nextRunAt != null && (
                <p className="text-xs">
                  {t("routines.nextRun", {
                    time: new Date(routine.nextRunAt).toLocaleString(),
                  })}
                </p>
              )}
            </div>
          )}
        </div>
        <RoutineRunsRail
          runs={runs}
          selectedSessionId={selected?.sessionId ?? null}
          onSelect={(run) => setPickedSessionId(run.sessionId)}
        />
      </div>

      <RoutineEditorComposer routineId={routine.id} />

      <RoutineDialog
        isOpen={editOpen}
        routine={routine}
        template={null}
        onClose={() => setEditOpen(false)}
      />
      <Dialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        icon={Trash2}
        title={t("routines.deleteTitle")}
        data-id="delete-routine-dialog"
        buttons={[
          {
            label: t("routines.cancel"),
            variant: "secondary",
            onClick: () => setDeleteOpen(false),
          },
          {
            label: t("routines.delete"),
            variant: "destructive",
            onClick: async () => {
              try {
                await removeMutation.mutateAsync(routine.id);
              } catch {
                return t("routines.deleteError");
              }
              setDeleteOpen(false);
              void navigate({ to: "/settings/jobs" });
              return true;
            },
          },
        ]}
      >
        <p className="text-muted-foreground text-sm">
          {t("routines.deleteBody", { name: routine.name })}
        </p>
      </Dialog>
    </div>
  );
};

/**
 * Talk to the routine about itself ("every morning at 9 instead", "stop"): a
 * short agent turn with only the cron tool. Nothing typed here becomes a run.
 */

const RoutineEditorComposer = ({
  routineId,
}: {
  routineId: string;
}): JSX.Element => {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const edit = useMutation({
    mutationFn: (message: string) =>
      window.api.agent.editRoutineByChat(routineId, message),
    onSuccess: (answer) => {
      setReply(answer);
      void client.invalidateQueries({ queryKey: workspaceQueryKeys.routines });
    },
    onError: (error: Error) => {
      toast.error(error.message, { id: "routine-edit" });
    },
  });
  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || edit.isPending) return;
    setReply(null);
    setText("");
    edit.mutate(trimmed);
  };

  return (
    <div
      className="border-border flex flex-col gap-1 border-t px-4 py-2"
      data-id="routine-editor"
    >
      {(reply != null || edit.isPending) && (
        <p
          className="text-muted-foreground text-xs"
          data-id="routine-editor-reply"
          aria-live="polite"
        >
          {edit.isPending ? t("routines.editorThinking") : reply}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t("routines.editorPlaceholder")}
          disabled={edit.isPending}
          data-id="routine-editor-input"
        />
        <Button
          size="sm"
          onClick={submit}
          disabled={text.trim().length === 0 || edit.isPending}
          data-id="routine-editor-send"
        >
          {t("routines.editorSend")}
        </Button>
      </div>
    </div>
  );
};

/**
 * One chat a bot answers on its own. The conversation is the run; the
 * header carries the grant — pause keeps the pairing and stops the answers,
 * remove takes the sender off the list and the chat with them.
 */
const AutoReplyPage = ({ sessionId }: { sessionId: string }): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const chatsQuery = useBotSenderChatsQuery();
  const chat: BotSenderChat | null =
    chatsQuery.data?.find((entry) => entry.sessionId === sessionId) ?? null;
  const bots = useBotsQuery().data ?? [];
  const bot =
    chat == null ? null : (bots.find((b) => b.id === chat.botId) ?? null);
  useShowSession(chat?.workspaceId ?? null, chat?.sessionId ?? null);

  const decide = useMutation({
    mutationFn: (request: MessagingPairingDecisionRequest) =>
      window.api.agent.decideMessagingPairing(request),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workspaceQueryKeys.bots });
      void client.invalidateQueries({
        queryKey: ["routines-messaging-snapshot"],
      });
    },
  });
  const decision = (
    verdict: MessagingPairingDecisionRequest["decision"]
  ): void => {
    if (chat?.userId == null) return;
    void decide
      .mutateAsync({
        platformId:
          chat.platform as MessagingPairingDecisionRequest["platformId"],
        userId: chat.userId,
        decision: verdict,
      })
      .then(() => {
        if (verdict === "revoke") void navigate({ to: "/settings/jobs" });
      })
      .catch(() =>
        toast.error(t("routines.updateError"), { id: "auto-reply" })
      );
  };

  if (chat == null) {
    return (
      <div
        className="text-muted-foreground flex h-full items-center justify-center text-sm"
        data-id="routine-page-missing"
      >
        {chatsQuery.isPending ? "" : t("routines.pageMissing")}
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-id={`auto-reply-page-${chat.sessionId}`}
    >
      <header className="border-border flex items-center gap-3 border-b px-4 py-2">
        <MessageCircle className="text-muted-foreground size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate text-sm font-medium"
            data-id="routine-page-name"
          >
            {chat.senderName}
          </span>
          <span
            className="text-muted-foreground truncate text-xs"
            data-id="routine-page-schedule"
          >
            {t("routines.autoReplyLine", {
              bot: bot?.name ?? "",
              platform: chat.platform,
            })}
          </span>
        </div>
        <Badge variant={chat.autoReply === "approved" ? "default" : "outline"}>
          {chat.autoReply === "approved"
            ? t("routines.autoReplyOn")
            : t("routines.autoReplyPaused")}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          data-id="auto-reply-page-toggle"
          disabled={chat.userId == null}
          onClick={() =>
            decision(chat.autoReply === "approved" ? "pause" : "resume")
          }
        >
          {chat.autoReply === "approved"
            ? t("routines.pause")
            : t("routines.resume")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive"
          aria-label={t("routines.delete")}
          title={t("routines.delete")}
          data-id="auto-reply-page-delete"
          disabled={chat.userId == null}
          onClick={() => decision("revoke")}
        >
          <Trash2 />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <ChatPanel />
      </div>
    </div>
  );
};
