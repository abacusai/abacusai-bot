/**
 * What a chat preview shows for a file in none of the chat's folders: a calm
 * card that adds the file's folder (then the preview opens) or opens the file
 * with its own app. A chat not yet started has no folders to add to.
 */
import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatCard } from "#renderer/components/chat-card";
import { openHostPath } from "#renderer/lib/open-host-path";
import { Button } from "#renderer/ui/button";

import { useSessionsTransport } from "../data/queries";
import { folderName, useSessionFolders } from "./session-folders";

export const OutsideFoldersCard = ({
  file,
  folder,
  sessionId,
}: {
  file: string;
  folder: string;
  sessionId: string | null;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const folders = useSessionFolders(sessionId);
  const [busy, setBusy] = useState(false);
  return (
    <div data-slot="outside-folders" className="p-3">
      <ChatCard
        icon={<FolderPlus />}
        title={t("sessions.folders.outsideTitle")}
        description={t("sessions.folders.outsideBody", {
          name: folderName(folder),
        })}
      >
        <div className="flex flex-wrap gap-2">
          {sessionId != null ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void folders.add(folder).finally(() => setBusy(false));
              }}
            >
              {t("sessions.folders.add")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void openHostPath(transport.client, file)}
          >
            {t("bots.chat.preview.openExternally")}
          </Button>
        </div>
      </ChatCard>
    </div>
  );
};
