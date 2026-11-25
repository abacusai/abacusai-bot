/**
 * What a local-file tab shows when main will not preview the file: it is in
 * neither the chat's folder nor a folder of a file the bot made. Calm, with
 * the one way to see it that still works: the file's own app.
 */
import { useTranslation } from "react-i18next";

import { isRpcError } from "#renderer/data/query-client";
import type { AppClient } from "#renderer/data/transport/types";
import { openHostPath } from "#renderer/lib/open-host-path";
import { Button } from "#renderer/ui/button";

/** Main's two refusals for a file outside every folder it previews from. */
export const isRefusedLocalFile = (error: unknown): boolean =>
  isRpcError(error) &&
  error.code === "FORBIDDEN" &&
  (error.data?.reason === "outside-root" ||
    error.data?.reason === "root-not-allowed");

export const RefusedLocalFile = ({
  client,
  file,
}: {
  client: AppClient;
  file: string;
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-2 p-3 text-sm" role="status">
      <p className="text-muted-foreground">
        {t("sessions.browser.outsideFolders")}
      </p>
      <Button
        variant="secondary"
        onClick={() => void openHostPath(client, file)}
      >
        {t("bots.chat.preview.openExternally")}
      </Button>
    </div>
  );
};
