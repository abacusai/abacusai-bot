/**
 * Delete confirmation (spec 03 §7.5, parity P24): Cancel has focus; Delete
 * shows a spinner while pending; an error stays in the dialog. Deleting the
 * open bot navigates first (§5.5): to the next bot in sidebar order, else
 * `/bots/new`.
 */
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "#renderer/components/spinner";
import { useDb } from "#renderer/data/db";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";
import type { BotRow } from "#shared/contract/rows";

import { deleteBot } from "../data/bot-actions";

export const DeleteBotDialog = ({
  bot,
  hasCheckIn,
  nextBotId,
  onClose,
}: {
  bot: BotRow | null;
  hasCheckIn: boolean;
  /** Where the pane goes when the open bot is deleted (sidebar order). */
  nextBotId: string | null;
  onClose(): void;
}) => {
  const { t } = useTranslation();
  const db = useDb();
  const navigate = useAppNavigate();
  const params = useParams({ strict: false }) as { botId?: string };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  const confirm = async (): Promise<void> => {
    if (bot == null) return;
    setPending(true);
    setError(false);
    await (async () => {
      try {
        await deleteBot(
          {
            bots: db.collections.bots,
            leave: () =>
              params.botId === bot.id
                ? nextBotId != null
                  ? navigate({
                      to: "/bots/$botId",
                      params: { botId: nextBotId },
                      replace: true,
                      transition: "nav-lateral",
                    })
                  : navigate({
                      to: "/bots/new",
                      replace: true,
                      transition: "nav-lateral",
                    })
                : undefined,
          },
          bot.id
        );
        onClose();
      } catch {
        setError(true);
      }
    })().finally(() => {
      setPending(false);
    });
  };

  return (
    <AlertDialog
      open={bot != null}
      onOpenChange={(open) => {
        if (!open && !pending) {
          setError(false);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("bots.deleteDialog.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("bots.deleteDialog.body", { name: bot?.name ?? "" })}
            {hasCheckIn ? ` ${t("bots.deleteDialog.checkIn")}` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {t("bots.deleteDialog.error")}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={pending}>
            {t("bots.deleteDialog.cancel")}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {t("bots.deleteDialog.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
