import { AgentMode } from "@abacus-ai/contract/agent-types";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { detectRememberRequest } from "@abacus-ai/contract/remember";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ConnectorRequestCard } from "#renderer/components/connector-request-card";
import { confirmFreePoolModel } from "#renderer/components/credits-card/actions";
import { useCollections } from "#renderer/data/db";
import { useVisibleThread } from "#renderer/lib/navigation/visible-thread";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem, openSharedLink } from "#renderer/lib/platform-system";
import { openPanelTab, panelScopeKey } from "#renderer/lib/side-panel/store";
import { showError, showInfo } from "#renderer/lib/toast";
import { Button } from "#renderer/ui/button";

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
  sender = false,
  onBrowser?: (url: string) => void
) => {
  const { t } = useTranslation();
  const collections = useCollections();
  const transport = useBotsTransport();
  const routine = useCheckIn(bot.id);
  const { data: session } = useLiveQuery({
    query: (q) =>
      q
        .from({ s: collections.sessions })
        .where(({ s }) => eq(s.id, sessionId))
        .findOne(),
  });
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
  const channel = IS_ELECTRON
    ? messaging.data?.platforms.find((row) => row.id === bot.channel)
    : undefined;
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
  // The panel's tabs live in the shell's store, scoped to this bot: a
  // sub-route, a dialog or a route transition never resets them.
  const panelKey = panelScopeKey("bots", bot.id)!;
  const setTab = (tab: "details" | "memory" | "files") =>
    openPanelTab(panelKey, { kind: tab });
  const openTarget = (target: BotOpenTarget): void => {
    if (target.kind === "external")
      void platformSystem(transport.client).openPath({ path: target.path });
    else if (target.kind === "preview")
      openPanelTab(panelKey, {
        kind: "files",
        path: target.path,
        title: target.path.split("/").at(-1),
      });
    else if (!IS_ELECTRON)
      void platformSystem(transport.client).openExternal({ url: target.url });
    else if (onBrowser) onBrowser(target.url);
    else openPanelTab(panelKey, { kind: "browser", url: target.url });
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
  const senderLabel = senderInfo?.senderName?.trim() || session?.label?.trim();
  const readOnlyReason = senderLabel
    ? t("bots.chat.senderReadOnly", { bot: bot.name, sender: senderLabel })
    : t("bots.chat.senderReadOnlyFallback", { bot: bot.name });
  const pairing = sender ? (
    <Button
      variant="secondary"
      size="sm"
      disabled={!senderInfo?.userId}
      title={!senderInfo?.userId ? readOnlyReason : undefined}
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
            reason: readOnlyReason,
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
                          void openSharedLink(transport.client, {
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
    onOpenExternal: (url) =>
      void platformSystem(transport.client).openExternal({ url }),
    onReveal: IS_ELECTRON
      ? (path) => void transport.client.system.showItemInFolder({ path })
      : undefined,
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
              onConnected={asks.connected}
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
      sharedElement: true,
      placeholder: t("bots.chat.placeholder", {
        name: bot.name.length > 40 ? bot.name.slice(0, 39) + "…" : bot.name,
      }),
      attachmentsBase: workspaceRoot,
      attachmentContext: async () => {
        if (!session)
          throw new Error("Select a session before uploading files");
        return { workspaceId: session.workspaceId, sessionId };
      },
      showModeChip: false,
      model: expanded && !readOnly ? binding : null,
      blocked:
        readOnly || binding.setup.status === "ready"
          ? undefined
          : binding.setup.status === "empty"
            ? ("no-model" as const)
            : binding.setup.status,
      fixedMode: mode.data ?? AgentMode.Normal,
      ...(!readOnly
        ? {
            onResumeOnFreePool: async () => {
              await setBotModel(collections.bots, bot.id, "abacus/openllm");
              if (session?.workspaceId) {
                await transport.client.agent.setModel({
                  workspaceId: session.workspaceId,
                  sessionId,
                  model: "abacus/openllm",
                });
                await confirmFreePoolModel(transport, {
                  workspaceId: session.workspaceId,
                  sessionId,
                });
              }
            },
          }
        : {}),
      onFirstSend: (text: string) => {
        if (detectRememberRequest(text) != null)
          showInfo(t("memory.rememberedToast"));
        react(bot.id, "wink");
        playBotCue("sent", sessionId, bot.id);
      },
      ...(readOnly
        ? { readOnly }
        : mode.data == null
          ? {
              readOnly: mode.isError
                ? {
                    reason: <span role="alert">{t("bots.openError")}</span>,
                    action: (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void mode.refetch()}
                      >
                        {t("chat.error.retry")}
                      </Button>
                    ),
                  }
                : { reason: t("common.loading") },
            }
          : {}),
    },
  };
};
