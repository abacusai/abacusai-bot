/**
 * The chat's folders in the context tray, like an add-folder control: its own
 * folder, the ones the user added (attached in a message, or here), a way to
 * add another and to remove one. The bot works and saves in them, and the
 * chat previews what is in them.
 */
import { useQuery } from "@tanstack/react-query";
import { FolderPlus, Folders, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { platformSystem } from "#renderer/lib/platform-system";
import { Button } from "#renderer/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";

import {
  useCheckoutQueries,
  useSession,
  useSessionsTransport,
  useWorkspace,
} from "../data/queries";
import { folderName, useSessionFolders } from "./session-folders";

const FolderRow = ({
  folder,
  label,
  onRemove,
}: {
  folder: string;
  label: string;
  onRemove?: () => void;
}) => (
  <div className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1">
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[13px]">{label}</span>
      <span className="text-muted-foreground truncate font-mono text-[11px]">
        {folder}
      </span>
    </div>
    {onRemove ? (
      <RemoveButton name={folderName(folder)} onClick={onRemove} />
    ) : null}
  </div>
);

const RemoveButton = ({
  name,
  onClick,
}: {
  name: string;
  onClick: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      aria-label={t("sessions.folders.remove", { name })}
      onClick={onClick}
    >
      <X />
    </Button>
  );
};

export const FoldersChip = ({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) => {
  const checkout = { workspaceId, sessionId };
  const status = useQuery(
    useCheckoutQueries(checkout).checkoutStatus(checkout)
  );
  const workspace = useWorkspace(workspaceId);
  const folders = useSession(sessionId)?.folders ?? [];
  return (
    <FoldersMenu
      sessionId={sessionId}
      chatFolder={status.data?.path ?? workspace?.path ?? null}
      folders={folders}
    />
  );
};

/** The chip and its list, from the chat's folders as main holds them. */
export const FoldersMenu = ({
  sessionId,
  chatFolder,
  folders,
}: {
  sessionId: string;
  chatFolder: string | null;
  folders: readonly string[];
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const actions = useSessionFolders(sessionId);
  const pick = async () => {
    const path = await platformSystem(transport.client).dialog.openFolder({});
    if (path) await actions.add(path);
  };
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-slot="folders-chip"
            aria-label={t("sessions.folders.label")}
            className="text-muted-foreground"
          />
        }
      >
        <Folders />
        {folders.length > 0
          ? t("sessions.folders.chipCount", { count: folders.length + 1 })
          : t("sessions.folders.chip")}
      </PopoverTrigger>
      <PopoverContent className="w-[min(380px,var(--available-width))] gap-1 rounded-[14px] p-1.5">
        <p className="text-muted-foreground px-2 py-1 text-xs">
          {t("sessions.folders.help")}
        </p>
        {chatFolder != null ? (
          <FolderRow
            folder={chatFolder}
            label={t("sessions.folders.chatFolder")}
          />
        ) : null}
        {folders.map((folder) => (
          <FolderRow
            key={folder}
            folder={folder}
            label={folderName(folder)}
            onRemove={() => void actions.remove(folder)}
          />
        ))}
        <Button
          variant="ghost"
          className="h-8 w-full justify-start rounded-lg px-2"
          onClick={() => void pick()}
        >
          <FolderPlus />
          {t("sessions.folders.addOther")}
        </Button>
      </PopoverContent>
    </Popover>
  );
};
