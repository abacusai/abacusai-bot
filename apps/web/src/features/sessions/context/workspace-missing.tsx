import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { platformSystem } from "#renderer/lib/platform-system";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";

import { useSessionsTransport } from "../data/queries";

export const WorkspaceMissing = ({
  workspaceId,
  retry,
  removed,
}: {
  workspaceId: string;
  retry(): void;
  removed(): void;
}) => {
  const { t } = useTranslation();
  const db = useDb();
  const transport = useSessionsTransport();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const relocate = async () => {
    const newPath = await platformSystem(transport.client).dialog.openFolder(
      {}
    );
    if (!newPath) return;
    await transport.client.workspaces.relocate({ workspaceId, newPath });
    await db.collections.workspaces.utils.resync();
    retry();
  };
  const remove = async () => {
    setBusy(true);
    await (async () => {
      try {
        await db.collections.workspaces.delete(workspaceId).isPersisted.promise;
        removed();
      } catch (e) {
        setError(String(e));
      }
    })().finally(() => {
      setBusy(false);
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => void relocate().catch((e) => setError(String(e)))}>
        {t("sessions.missing.choose")}
      </Button>
      <Button variant="ghost" onClick={() => setConfirm(true)}>
        {t("sessions.missing.deleteWorkspace")}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sessions.missing.deleteWorkspace")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessions.missing.deleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sessions.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void remove()}>
              {t("sessions.missing.deleteWorkspace")}
            </AlertDialogAction>
          </AlertDialogFooter>
          {error ? <p role="alert">{error}</p> : null}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
