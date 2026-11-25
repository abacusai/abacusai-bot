import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { errorText } from "#renderer/lib/error-text";
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
  body,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  description: string;
  label: string;
  children?: ReactNode;
  /** Options that belong to this decision, shown under the description. */
  body?: ReactNode;
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
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => setOpen(true)}
        >
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
          {body}
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
                  .catch((e) => setError(errorText(e)))
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
