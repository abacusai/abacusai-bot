/**
 * Adding and removing a chat's folders. Main checks the folder and owns the
 * list (the session row's `folders`); every preview's answer is asked again
 * after a change, since a file refused a moment ago may now show.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { isRpcError } from "#renderer/data/query-client";
import { showError } from "#renderer/lib/toast";

import { useSessionsTransport } from "../data/queries";

export const folderName = (folder: string): string =>
  folder.split(/[\\/]/).findLast((part) => part !== "") ?? folder;

export const useSessionFolders = (sessionId: string | null | undefined) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: transport.orpc.browser.runtime.previewRoot.key(),
    });
  const add = async (path: string): Promise<boolean> => {
    if (sessionId == null) return false;
    try {
      await transport.client.sessions.folders.add({ sessionId, path });
    } catch (error) {
      showError(
        isRpcError(error) && error.code === "FORBIDDEN"
          ? t("sessions.folders.notAllowed", { name: folderName(path) })
          : t("sessions.folders.addFailed")
      );
      return false;
    }
    await refresh();
    return true;
  };
  const remove = async (path: string): Promise<void> => {
    if (sessionId == null) return;
    try {
      await transport.client.sessions.folders.remove({ sessionId, path });
    } catch {
      showError(t("sessions.folders.removeFailed"));
      return;
    }
    await refresh();
  };
  return { add, remove, refresh };
};
