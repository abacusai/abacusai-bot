import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ConnectorRequestCard } from "#next/components/connector-request-card";
import { useCollections } from "#next/data/db";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { useVisibleThread } from "#next/lib/navigation/visible-thread";
import { showError, showInfo } from "#next/lib/toast";
import { Button } from "#next/ui/button";
import { AgentMode } from "#shared/agent-types";
import type { BotRow } from "#shared/contract/rows";
import { sessionConversationKey } from "#shared/conversation-scope";
import type { MessagingPlatformId } from "#shared/messaging";
import { detectRememberRequest } from "#shared/remember";

import { react } from "../avatar";
import { setBotModel, setCheckInsEnabled } from "../data/bot-actions";
import { botsQueries } from "../data/queries";
import { useCheckIn } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import { botsUnreadStore } from "../data/unread-store";
import { useBotModelBinding } from "../model/picker";
import { playBotCue } from "../watcher";
import { useConnectorRequests } from "./connector-requests";
import { botMessageDecorations, feedbackSender } from "./decorations";
import {
  openBotFile,
  usePreviewOpenBridge,
  type BotOpenTarget,
} from "./preview";
export const useBotChatSlots = (
  bot: BotRow,
  sessionId: string,
  expanded: boolean,
  sender = false
) => {
  const { t } = useTranslation();
  const collections = useCollections();
  const transport = useBotsTransport();
  const navigate = useAppNavigate();
  const routine = useCheckIn(bot.id);
  const { data: session } = useLiveQuery(
    (q) =>
      q
        .from({ s: collections.sessions })
        .where(({ s }) => eq(s.id, sessionId))
        .findOne(),
    [sessionId]
  );
  const { data: workspaces } = useLiveQuery((q) =>
    q.from({ w: collections.workspaces })
  );
  const workspaceRoot =
    workspaces?.find((row) => row.id === session?.workspaceId)?.path ?? null;
  const queries = botsQueries(transport.orpc);
  const account = useQuery(queries.account());
  const mode = useQuery(queries.defaultMode());
  const messaging = useQuery(queries.messaging());
  const senders = useQuery(queries.senderChats());
  const channel = messaging.data?.platforms.find(
    (row) => row.id === bot.channel
  );
  const senderInfo = senders.data?.find((row) => row.sessionId === sessionId);
  const isRun = !!session?.routineId;
  const key = session?.workspaceId
    ? sessionConversationKey(session.workspaceId, sessionId)
    : null;
  const asks = useConnectorRequests(transport, key);
  useVisibleThread(sessionId);
  useEffect(() => {
    botsUnreadStore.clear(bot.id);
  }, [bot.id, sessionId]);
  const setTab = (tab: "details" | "memory" | "files") =>
    void navigate({
      search: (previous) => ({ ...previous, tab }),
      transition: "none",
    });
  const openTarget = (target: BotOpenTarget): void => {
    if (target.kind === "external")
      void transport.client.system.openPath({ path: target.path });
    else if (target.kind === "preview")
      void navigate({
        search: (previous) => ({
          ...previous,
          tab: "files",
          preview: target.path,
        }),
        transition: "none",
      });
    else
      void navigate({
        search: (previous) => ({ ...previous, tab: "browser" }),
        transition: "none",
      });
  };
  const openFile = (path: string) =>
    openTarget(openBotFile(path, workspaceRoot));
  usePreviewOpenBridge(transport, key, workspaceRoot, openTarget);
  const binding = useBotModelBinding(
    bot.model,
    (model) =>
      void setBotModel(collections.bots, bot.id, model).catch(() =>
        showError(t("bots.form.saveError"))
      ),
    `model:${bot.id}`
  );
  const pairing = sender ? (
    <Button
      variant="secondary"
      size="sm"
      disabled={!senderInfo?.userId}
      title={
        !senderInfo?.userId
          ? t("bots.chat.senderReadOnly", {
              bot: bot.name,
              sender: session?.label ?? "",
            })
          : undefined
      }
      onClick={() =>
        void transport.client.messaging
          .decidePairing({
            platformId: senderInfo!.platform as MessagingPlatformId,
            userId: senderInfo!.userId!,
            decision: senderInfo?.autoReply === "approved" ? "pause" : "resume",
          })
          .catch(() => showError(t("bots.form.saveError")))
      }
    >
      {t(
        senderInfo?.autoReply === "approved"
          ? "bots.chat.pause"
          : "bots.chat.resume"
      )}
    </Button>
  ) : undefined;
  const workspaceDeleted =
    workspaces != null &&
    session?.workspaceId != null &&
    !workspaces.some(
      (workspace) =>
        workspace.id === session.workspaceId && workspace.status !== "deleted"
    );
  const readOnly = workspaceDeleted
    ? { reason: t("workspace.deletedWorkspaceReadOnly") }
    : isRun
      ? { reason: t("routines.runReadOnly") }
      : sender
        ? {
            reason: t("bots.chat.senderReadOnly", {
              bot: bot.name,
              sender: senderInfo?.senderName ?? session?.label ?? "",
            }),
            ...(pairing ? { action: pairing } : {}),
          }
        : bot.channel
          ? {
              reason: t(
                bot.channel === "whatsapp"
                  ? "bots.chat.channelReadOnlyWhatsapp"
                  : "bots.chat.channelReadOnly",
                { app: bot.channel }
              ),
              ...(channel?.sharedLink
                ? {
                    action: (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void transport.client.messaging.openSharedLink({
                            platformId: channel.id,
                            target: "dm",
                          })
                        }
                      >
                        {t("bots.chat.openApp", { app: channel.id })}
                      </Button>
                    ),
                  }
                : {}),
            }
          : undefined;
  const decorateMessage = botMessageDecorations({
    sessionId,
    model: session?.model,
    feedbackEnabled: account.data != null,
    sendFeedback: feedbackSender(transport),
    workspaceRoot,
    onOpenFile: openFile,
    onOpenUrl: (url) => openTarget({ kind: "browser", url }),
    onOpenExternal: (url) => void transport.client.system.openExternal({ url }),
    onReveal: (path) => void transport.client.system.showItemInFolder({ path }),
  });
  return {
    session,
    workspaceRoot,
    binding,
    setTab,
    openFile,
    chat: {
      decorateMessage,
      isMessageHidden: decorateMessage.isMessageHidden,
      banner: (
        <>
          {asks.current && (
            <ConnectorRequestCard
              request={asks.current}
              busy={asks.busy}
              error={asks.error}
              onConnect={asks.connect}
              onDecline={asks.decline}
              onStop={asks.stop}
            />
          )}
          {routine && !routine.enabled && (
            <div
              role="status"
              className="text-muted-foreground flex justify-center gap-2 text-xs"
            >
              {t("bots.chat.paused")}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void setCheckInsEnabled(collections.routines, routine, true)
                }
              >
                {t("bots.chat.resume")}
              </Button>
            </div>
          )}
        </>
      ),
    },
    composer: {
      mode: "full" as const,
      placeholder: t("bots.chat.placeholder", { name: bot.name }),
      attachmentsBase: workspaceRoot,
      showModeChip: false,
      model: expanded && !readOnly ? binding : null,
      fixedMode: mode.data ?? AgentMode.Yolo,
      onFirstSend: (text: string) => {
        if (detectRememberRequest(text) != null)
          showInfo(t("memory.rememberedToast"));
        react(bot.id, "happy");
        playBotCue("sent", sessionId, bot.id);
      },
      ...(readOnly ? { readOnly } : {}),
    },
  };
};
