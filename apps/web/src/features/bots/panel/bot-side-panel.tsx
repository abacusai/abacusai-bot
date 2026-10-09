import type { ArtifactRow, BotRow } from "@abacus-ai/contract/contract/rows";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { BotMemoryList } from "#renderer/components/bot-memory-list";
import { ConnectorMark } from "#renderer/components/connector-mark";
import { EmptyState } from "#renderer/components/empty-state";
import {
  FilePreview,
  containmentRootFor,
} from "#renderer/components/file-preview";
import { FileTreeView } from "#renderer/components/file-tree";
import { GroupCard } from "#renderer/components/form-kit/page";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { checkInFromRoutine } from "#renderer/lib/bots/check-in";
import { weekdayName } from "#renderer/lib/bots/schedule";
import { cn } from "#renderer/lib/cn";
import { formatWhen } from "#renderer/lib/format-time";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { showError, showInfo } from "#renderer/lib/toast";
import { useNow } from "#renderer/lib/use-now";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";

import { BotFace } from "../avatar";
import {
  clearMemory,
  forgetMemory,
  setPinned,
  updateBot,
} from "../data/bot-actions";
import {
  useBotMemories,
  useBotFiles,
  useBotSessions,
  useCheckIn,
  botsQueries,
} from "../data/queries";
import { useBotsTransport } from "../data/transport";
import { ModelPicker, type useBotModelBinding } from "../model/picker";
import { DeleteBotDialog } from "../sidebar/delete-dialog";
import { WallpaperPicker } from "./wallpaper-picker";
export const DetailsTab = ({
  bot,
  binding,
  modelInComposer,
  setTab,
}: {
  bot: BotRow;
  binding: ReturnType<typeof useBotModelBinding>;
  modelInComposer: boolean;
  setTab(tab: "details" | "memory" | "files"): void;
}) => {
  const { t, i18n } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const transport = useBotsTransport();
  const queries = botsQueries(transport.orpc);
  const memory = useQuery(queries.memoryBots());
  const senders = useQuery(queries.senderChats());
  const messaging = useQuery(queries.messaging());
  const routine = useCheckIn(bot.id);
  const sessions = useBotSessions(bot.id);
  const files = useBotFiles(bot.id);
  const [deleting, setDeleting] = useState(false);
  const check = checkInFromRoutine(routine);
  const pinned = prefs.pinned.botIds.includes(bot.id);
  const senderRows = (senders.data ?? []).filter((row) => row.botId === bot.id);
  const reachable =
    messaging.data?.platforms.filter(
      (platform) =>
        platform.id === bot.channel ||
        messaging.data.approved.some(
          (row) => row.platform === platform.id && row.botId === bot.id
        )
    ) ?? [];
  const memoryCount =
    memory.data?.find((row) => row.botId === bot.id)?.entries.length ?? 0;
  return (
    <div
      className="flex min-w-0 shrink-0 flex-col gap-4 p-4 pb-6"
      data-slot="bot-details"
    >
      <div className="flex flex-col items-center gap-1 py-2">
        <BotFace bot={bot} size={72} />
        <h2 className="max-w-full text-center text-base font-semibold [overflow-wrap:anywhere]">
          {bot.name}
        </h2>
        <p className="text-muted-foreground max-w-full text-center text-xs [overflow-wrap:anywhere]">
          {bot.title}
        </p>
        {bot.channel == null && (
          <AppLink
            to="/bots/$botId/edit"
            params={{ botId: bot.id }}
            className="bg-secondary mt-2 rounded-full px-3 py-2 text-xs"
          >
            {t("bots.sidebar.edit")}
          </AppLink>
        )}
      </div>
      <GroupCard className="px-0">
        <div
          className="flex min-h-(--setting-row-min) items-center justify-between gap-2 px-3"
          aria-label={t("bots.panel.modelValue", { model: binding.label })}
        >
          <span className="shrink-0 text-xs">{t("bots.form.model")}</span>
          {modelInComposer ? (
            <span
              aria-hidden
              className="text-muted-foreground min-w-0 truncate text-xs"
            >
              {binding.label}
            </span>
          ) : (
            <div className="flex min-w-0 justify-end">
              <ModelPicker binding={binding} readOnly={bot.channel != null} />
            </div>
          )}
        </div>
        <AppLink
          to="/bots/$botId/check-in"
          params={{ botId: bot.id }}
          transition="none"
          className="flex h-(--setting-row-min) items-center justify-between gap-2 px-3 text-xs"
        >
          <span className="shrink-0">{t("bots.checkIn.label")}</span>
          <span className="text-muted-foreground min-w-0 truncate text-end">
            {!check.enabled
              ? t("bots.checkIn.paused")
              : check.preset === "custom"
                ? t("bots.checkIn.customLabel")
                : t(`bots.checkIn.${check.preset}`)}{" "}
            {["daily", "weekdays", "weekly"].includes(check.preset)
              ? check.time
              : ""}
            {check.preset === "weekly"
              ? ` ${weekdayName(check.weekday, i18n.language)}`
              : ""}
          </span>
        </AppLink>
        <Button
          variant="ghost"
          className="h-(--setting-row-min) justify-between rounded-none px-3 text-xs font-normal"
          onClick={() => setTab("memory")}
        >
          <span>{t("bots.panel.memoryTitle")}</span>
          <span className="text-muted-foreground text-xs">
            {t("bots.panel.memoryCount", { count: memoryCount })}
          </span>
        </Button>
        <Button
          variant="ghost"
          className="h-(--setting-row-min) justify-between rounded-none px-3 text-xs font-normal"
          onClick={() => setTab("files")}
        >
          <span>{t("bots.panel.filesTitle")}</span>
          <span className="text-muted-foreground text-xs">{files.length}</span>
        </Button>
      </GroupCard>
      <WallpaperPicker
        value={bot.wallpaper}
        onChange={(wallpaper) =>
          void updateBot(db.collections.bots, bot.id, { wallpaper }).catch(() =>
            showError(t("bots.form.saveError"))
          )
        }
      />
      {routine &&
        sessions.some((session) => session.routineId === routine.id) && (
          <section>
            <h3 className="text-muted-foreground mb-2 text-xs">
              {t("bots.panel.checkIns")}
            </h3>
            {sessions
              .filter((s) => s.routineId === routine.id)
              .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
              .slice(0, 5)
              .map((session) => (
                <AppLink
                  key={session.id}
                  to="/bots/$botId/chats/$sessionId"
                  params={{ botId: bot.id, sessionId: session.id }}
                  className="flex h-11 items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 truncate">
                    {new Date(session.createdAt).toLocaleString(i18n.language)}
                  </span>
                  <span className="shrink-0">{session.runOutcome}</span>
                </AppLink>
              ))}
          </section>
        )}
      {senderRows.length > 0 && (
        <section>
          <h3 className="text-muted-foreground text-xs">
            {t("bots.panel.senderChats")}
          </h3>
          {senderRows.map((row) => (
            <AppLink
              key={row.sessionId}
              to="/bots/$botId/chats/$sessionId"
              params={{ botId: bot.id, sessionId: row.sessionId }}
              className="flex h-11 items-center gap-2 text-xs"
            >
              <ConnectorMark id={row.platform} size={20} />
              <span className="min-w-0 flex-1 truncate">
                {row.senderName?.trim() ||
                  t("bots.chat.senderReadOnlyFallback", { bot: bot.name })}
              </span>
              <span>
                {t(
                  row.autoReply === "approved"
                    ? "bots.panel.on"
                    : "bots.checkIn.paused"
                )}
              </span>
            </AppLink>
          ))}
        </section>
      )}
      {reachable.length > 0 && (
        <section>
          <h3 className="text-muted-foreground text-xs">
            {t("bots.panel.reachable")}
          </h3>
          {reachable.map((platform) => (
            <AppLink
              key={platform.id}
              to="/library/messaging"
              className="flex h-11 items-center gap-2 text-xs"
            >
              <ConnectorMark id={platform.id} size={20} />
              <span className="min-w-0 truncate">{platform.id}</span>
              <span className="ml-auto shrink-0">
                {t("bots.panel.connected")}
              </span>
            </AppLink>
          ))}
        </section>
      )}
      <div className="bg-background sticky bottom-0 z-10 -mx-4 -mb-6 flex min-w-0 flex-wrap gap-2 border-t px-4 py-3">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={() =>
            void setPinned(db, prefs.pinned.botIds, bot.id, !pinned).catch(() =>
              showError(t("bots.errors.pin"))
            )
          }
        >
          {t(pinned ? "bots.sidebar.unpin" : "bots.sidebar.pin")}
        </Button>
        {bot.channel == null && (
          <Button
            variant="ghost"
            className="text-destructive flex-1"
            onClick={() => setDeleting(true)}
          >
            {t("bots.sidebar.delete")}
          </Button>
        )}
      </div>
      <DeleteBotDialog
        bot={deleting ? bot : null}
        hasCheckIn={routine != null}
        nextBotId={null}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
};
export const MemoryTab = ({ bot }: { bot: BotRow }) => {
  const { t } = useTranslation();
  const db = useDb();
  const transport = useBotsTransport();
  const entries = useBotMemories(bot.id);
  const memory = useQuery(botsQueries(transport.orpc).memoryBots());
  const noteDays =
    memory.data?.find((row) => row.botId === bot.id)?.noteDays ?? 0;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void db.collections.memories.preload();
  }, [db]);
  return (
    <div className="flex flex-col gap-3 p-4">
      {!entries.length ? (
        <EmptyState
          title={t("bots.panel.memory.empty")}
          description={t("bots.panel.memoryIntro", { name: bot.name })}
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("bots.panel.memoryIntro", { name: bot.name })}
        </p>
      )}
      {entries.length > 0 && (
        <BotMemoryList
          entries={entries}
          onForget={(row) =>
            void forgetMemory(db.collections.memories, row)
              .then((result) => {
                if (result === "stale")
                  showInfo(t("bots.errors.memoryConflict"));
              })
              .catch(() => showError(t("bots.errors.memory")))
          }
        />
      )}
      {noteDays > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("bots.panel.memory.notes", { count: noteDays })}
        </p>
      )}
      {entries.length > 0 && (
        <Button
          variant="ghost"
          className="text-destructive"
          onClick={() => setConfirm(true)}
        >
          {t("bots.panel.memory.clear")}
        </Button>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("bots.panel.memory.clearConfirm")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("bots.panel.memoryIntro", { name: bot.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>
              {t("bots.form.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void clearMemory(transport, bot.id)
                  .then(() => setConfirm(false))
                  .catch(() => showError(t("bots.errors.memory")))
                  .finally(() => setBusy(false));
              }}
            >
              {t("bots.panel.memory.clear")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
/**
 * The bot's files as a tree (03-bots §12.3 amended, canvas `BotChatPanel`
 * "Files"): the artifacts of every session the bot owns, laid out by their
 * path under the workspace (elsewhere, by their absolute path), beside the
 * open file. A click previews in this tab; a double-click or Enter opens
 * the file in a new Files tab. Links sit under the tree.
 */
const treeOf = (
  files: readonly ArtifactRow[],
  workspaceRoot: string | null
): { paths: string[]; byPath: Map<string, string> } => {
  const byPath = new Map<string, string>();
  const dirs = new Set<string>();
  for (const file of files) {
    if (file.kind === "link") continue;
    const relative =
      workspaceRoot && file.location.startsWith(`${workspaceRoot}/`)
        ? file.location.slice(workspaceRoot.length + 1)
        : file.location.replace(/^\/+/, "");
    byPath.set(relative, file.location);
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return {
    paths: [...dirs, ...byPath.keys()].toSorted((a, b) => a.localeCompare(b)),
    byPath,
  };
};

export const FilesTab = ({
  bot,
  sessionId,
  tab,
  workspaceRoot,
  onOpen,
}: {
  bot: BotRow;
  sessionId?: string;
  /** This Files tab; `tab.path` is the open file. */
  tab: { id: string; path?: string };
  workspaceRoot: string | null;
  /** Show `path` here (undefined clears it), or in a new Files tab. */
  onOpen(path: string | undefined, where: "here" | "tab"): void;
}) => {
  const { t, i18n } = useTranslation();
  const db = useDb();
  const transport = useBotsTransport();
  const files = useBotFiles(bot.id);
  const now = useNow();
  useEffect(() => {
    void db.collections.artifacts.preload();
  }, [db]);
  const preview = tab.path;
  const tree = treeOf(files, workspaceRoot);
  const links = files.filter((file) => file.kind === "link");
  const open = (relative: string, where: "here" | "tab") => {
    const location = tree.byPath.get(relative);
    if (location) onOpen(location, where);
  };
  return (
    <div
      className="@container flex min-h-0 flex-1 flex-col"
      data-slot="bot-files"
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          preview && "@xl:flex-row"
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-col gap-3 overflow-y-auto p-3",
            preview
              ? "max-h-[40%] shrink-0 border-b @xl:max-h-none @xl:w-60 @xl:border-r @xl:border-b-0"
              : "flex-1"
          )}
        >
          {files.length === 0 ? (
            <EmptyState
              title={t("bots.panel.filesEmpty")}
              description={t("bots.panel.filesIntro")}
            />
          ) : (
            <p className="text-muted-foreground text-xs">
              {t("bots.panel.filesIntro")}
            </p>
          )}
          {tree.paths.length > 0 && (
            <FileTreeView
              checkoutIdentity={`${bot.id}:${workspaceRoot ?? ""}`}
              paths={tree.paths}
              onSelect={(path) => {
                if (!path.endsWith("/")) open(path, "here");
              }}
              onOpen={(path) => {
                if (!path.endsWith("/")) open(path, "tab");
              }}
              onRename={() => undefined}
              renderMenu={(item, context) =>
                item.path.endsWith("/") ? null : (
                  <div
                    role="menu"
                    className="bg-popover flex flex-col rounded-lg border p-1 shadow-md"
                  >
                    {[
                      {
                        label: t("bots.panel.openInNewTab"),
                        run: () => open(item.path, "tab"),
                      },
                      ...(IS_ELECTRON
                        ? [
                            {
                              label: t("artifacts.revealInFolder"),
                              run: () =>
                                void transport.client.system.showItemInFolder({
                                  path: tree.byPath.get(item.path) ?? "",
                                }),
                            },
                          ]
                        : []),
                    ].map((action) => (
                      <Button
                        key={action.label}
                        role="menuitem"
                        size="sm"
                        variant="ghost"
                        className="justify-start"
                        onClick={() => {
                          context.close();
                          action.run();
                        }}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                )
              }
            />
          )}
          {links.map((file) => (
            <Button
              key={file.id}
              variant="ghost"
              className="h-12 w-full justify-start"
              onClick={() =>
                void platformSystem(transport.client).openExternal({
                  url: file.location,
                })
              }
            >
              <span
                aria-hidden
                className="bg-muted size-[26px] shrink-0 rounded-md"
              />
              <span className="flex min-w-0 flex-col items-start">
                <span className="max-w-full truncate">
                  {file.title || file.location}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatWhen(file.createdAt, now, i18n.language)}
                </span>
              </span>
            </Button>
          ))}
        </div>
        {preview && (
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("bots.panel.backFiles")}
              className="absolute top-1.5 right-2 z-10"
              onClick={() => onOpen(undefined, "here")}
            >
              <X />
            </Button>
            <FilePreview
              path={preview}
              hostRoot={containmentRootFor(preview, workspaceRoot)}
              read={{
                localUrl: IS_ELECTRON
                  ? async (filePath, hostRoot) => {
                      const viewedId = sessionId ?? bot.sessionId;
                      const viewed = viewedId
                        ? db.collections.sessions.get(viewedId)
                        : undefined;
                      if (!viewed?.workspaceId)
                        throw new Error("Session workspace unavailable");
                      const state =
                        await transport.client.browser.runtime.materializeFile({
                          filePath,
                          hostRoot,
                          conversationKey: sessionConversationKey(
                            viewed.workspaceId,
                            viewed.id
                          ),
                          resourceId: `bot-preview:${filePath}`,
                        });
                      await transport.client.browser.runtime.close(state.lease);
                      return state.url;
                    }
                  : undefined,
                text: (path, hostRoot) =>
                  transport.client.files.readText({ filePath: path, hostRoot }),
                image: async (path, hostRoot) =>
                  (
                    await transport.client.files.readImageAsDataUrl({
                      filePath: path,
                      hostRoot,
                    })
                  ).dataUrl,
                pptx: (path, hostRoot) =>
                  transport.client.files.readPptx({ filePath: path, hostRoot }),
              }}
              onOpenExternally={
                IS_ELECTRON
                  ? (path) => void transport.client.system.openPath({ path })
                  : undefined
              }
              onReveal={
                IS_ELECTRON
                  ? (path) =>
                      void transport.client.system.showItemInFolder({ path })
                  : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  );
};
