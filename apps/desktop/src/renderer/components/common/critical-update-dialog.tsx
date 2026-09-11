import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { useUpdateInstall, useUpdateStatus } from "./use-update-status";

/** How long the dialog counts down before installing on its own. */
const AUTO_INSTALL_SECONDS = 5 * 60;

/** m:ss for the countdown line — 300 → "5:00", 61 → "1:01". */
const formatCountdown = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

/**
 * The one update the user cannot defer: a publisher-flagged critical release
 * (`criticalBelow`). A controlled `open` with no close handler cannot be
 * dismissed from backdrop or keyboard. Stands down once an install stalled.
 */
export const CriticalUpdateDialog = () => {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const { installing, install, reset } = useUpdateInstall(status);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_INSTALL_SECONDS);

  const open =
    status?.downloaded === true &&
    status.criticalUpdate &&
    status.installStalled !== true;

  // Each opening restarts the clock; a reopened dialog must not sit at 0:00.

  useEffect(() => {
    if (!open) return;
    setSecondsLeft(AUTO_INSTALL_SECONDS);
    reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      setSecondsLeft((prev) => Math.max(prev - 1, 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [open]);

  // Zero means install; the service's guard makes a duplicate call a no-op.

  useEffect(() => {
    if (!open || secondsLeft > 0 || installing) return;
    install();
  }, [open, secondsLeft, installing, install]);

  const version = status?.updateInfo?.version;

  return (
    <AlertDialog open={open}>
      <AlertDialogContent data-id="critical-update-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <ShieldAlert />
          </AlertDialogMedia>
          <AlertDialogTitle data-id="critical-update-title">
            {t("updateCritical.title")}
          </AlertDialogTitle>
          <AlertDialogDescription data-id="critical-update-body">
            {version
              ? t("updateCritical.bodyWithVersion", { version })
              : t("updateCritical.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="items-center gap-3 sm:justify-between">
          <span
            data-id="critical-update-countdown"
            className="text-muted-foreground text-xs tabular-nums"
          >
            {t("updateCritical.countdown", {
              time: formatCountdown(secondsLeft),
            })}
          </span>
          <AlertDialogAction
            data-id="critical-update-restart"
            disabled={installing}
            onClick={install}
          >
            {installing
              ? t("updateCritical.restarting")
              : t("updateCritical.restartNow")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
