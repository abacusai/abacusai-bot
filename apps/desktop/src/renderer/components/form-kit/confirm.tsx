import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
export const ConfirmAction = ({
  title,
  description,
  label,
  children,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  description: string;
  label: string;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onConfirm(): Promise<unknown>;
}) => {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {controlledOpen === undefined && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {children ?? label}
        </Button>
      )}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("phase5.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void onConfirm()
                  .then(() => setOpen(false))
                  .catch((e) =>
                    setError(
                      e instanceof Error ? e.message : t("phase5.failed")
                    )
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {label}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
